import { get, writable } from 'svelte/store';
import { TelegramKeyHash, Api, client, session, cachedDatabase } from '../utils/bootstrap';

export const connectionStatus = writable(false);
export const authorizedStatus = writable(false);
export const authorizedUser = writable([]);
export const chatCollections = writable([]);
export const cachedThumbnails = writable({});
export const downloadMedia = writable({});

client.addEventHandler((evt) => {
  switch (evt.className) {
    case "UpdateNotifySettings":
    case "UpdateFolderPeers":
    case "UpdateNewMessage":
    case "UpdateEditMessage":
    case "UpdateDeleteMessages":
    case "UpdateNewChannelMessage":
    case "UpdateEditChannelMessage":
    case "UpdateDeleteChannelMessages":
    case "UpdateShortMessage":
    case "UpdateReadHistoryInbox":
    case "UpdateReadHistoryOutbox":
    case "UpdateReadMessagesContents":
    case "UpdateReadChannelInbox":
    case "UpdateReadChannelOutbox":
    case "UpdateReadFeaturedStickers":
    case "UpdateReadChannelDiscussionInbox":
    case "UpdateReadChannelDiscussionOutbox":
    // case "UpdateMessagePoll":
    case "Updates":
      retrieveChats();
      break
    case "UpdatesTooLong":
      isUserAuthorized();
      break
    default:
      console.log('client.addEventHandler:', evt);
  }
  if (evt.state) {
    if (evt.state === 1)
      connectionStatus.update(n => true);
    else if (evt.state === -1)
      connectionStatus.update(n => false);
  }
});

client.connect()
.then(() => {
  connectionStatus.update(n => true);
  isUserAuthorized();
})
.catch(err => {
  connectionStatus.update(n => false);
});

export async function fetchUser() {
  const result = await client.invoke(
    new Api.users.GetUsers({
      id: [new Api.InputPeerSelf()],
    })
  );
  authorizedUser.update(n => result);
}

export async function isUserAuthorized() {
  try {
    const authorized = await client.isUserAuthorized();
    authorizedStatus.update(n => authorized);
    if (authorized) {
      await fetchUser();
      retrieveChats();
      window['web_worker'] = runWorker();
      window['web_worker'].onmessage = async (e) => {
        switch (e.data.type) {
          case -1:
            console.log('Err', e.data.params.toString());
            break;
          case 0:
            console.log('Connected to web worker');
            break;
          case 1:
            downloadMedia.update(n => e.data);
            break;
          case 2:
            (await cachedDatabase).put('profilePhotos', e.data.result, e.data.hash.photoId);
            updateThumbCached(e.data.hash.photoId, e.data.result);
            break;
        }
      }
    }
  } catch (err) {
    console.log(err);
  }
}

export async function retrieveChats() {
  try {
    const lbl = 'retrieveChats';
    console.time(lbl);
    const chatPreferencesTask = {};
    const user = await getAuthorizedUser();
    const chats = await client.getDialogs({
      offsetPeer: new Api.InputPeerSelf(),
      limit: 100,
      excludePinned: true,
      folderId: 0,
    });
    console.timeEnd(lbl);
    const httpTasks = [];
    const websocketTasks = [];
    chats.forEach((chat, index) => {
      chat.__isSavedMessages = false;
      if (chat.id.value === user[0].id.value) {
        chat.name = 'Saved Messages';
        chat.entity.__isSavedMessages = true;
      }
      chat.entity.__muted = false;
      if (chat.dialog.notifySettings.muteUntil != null) {
        chat.entity.__muted = chat.dialog.notifySettings.muteUntil;
      }
      if (chatPreferencesTask[chat.entity.id.value.toString()] == null) {
        chatPreferencesTask[chat.entity.id.value.toString()] = {};
      }
      chatPreferencesTask[chat.entity.id.value.toString()]['muted'] = chat.dialog.notifySettings.muteUntil || false;
      chatPreferencesTask[chat.entity.id.value.toString()]['scrollAt'] = chat.message.id;
      chat.iconRef = chat.id.toString();
      if (!(chat.entity.username == null && chat.entity.phone == null) && chat.entity.photo != null && chat.entity.photo.className !== 'ChatPhotoEmpty') {
        chat.iconRef = chat.entity.photo.photoId.toString();
        httpTasks.push({
          url: `https://api.codetabs.com/v1/proxy/?quest=https://t.me/${chat.entity.phone === "42777" ? 'telegram' : chat.entity.username}`,
          photoId: chat.entity.photo.photoId.toString(),
          chat: chat
        });
      } else if (chat.entity.photo != null && chat.entity.photo.className !== 'ChatPhotoEmpty') {
        chat.iconRef = chat.entity.photo.photoId.toString();
        websocketTasks.push({
          photoId: chat.entity.photo.photoId.toString(),
          chat: chat
        });
      }
      const letters = chat.name.split(' ').map(text => {
        return text[0];
      });
    });
    chatCollections.update(n => chats);
    runTask(httpTasks, websocketTasks, chatPreferencesTask);
    return chats;
  } catch (err) {
    console.log(err);
  }
}

export function getChatCollection() {
  return get(chatCollections)
}

export function getCachedThumbnails() {
  return get(cachedThumbnails)
}

export function getAuthorizedUser() {
  return get(authorizedUser);
}

export async function runTask(httpTasks, websocketTasks, chatPreferencesTask = {}) {
  // const lbl = `[NON-BLOCKING]:chatPreferencesTask ${Object.keys(chatPreferencesTask).length}`;
  // console.time(lbl);
  for (let chatId in chatPreferencesTask) {
    try {
      let pref = await (await cachedDatabase).get('chatPreferences', chatId);
      if (pref == null)
        pref = {};
      pref['muted'] = chatPreferencesTask[chatId]['muted'];
      if (pref['scrollAt'] == null) {
        pref['scrollAt'] = chatPreferencesTask[chatId]['scrollAt'];
      }
      await (await cachedDatabase).put('chatPreferences', pref, chatId);
    } catch (err) {
      console.log('chatPreferencesTask:', err);
    }
  }
  // console.timeEnd(lbl);

  // const lbl2 = `[NON-BLOCKING]:httpTasks ${httpTasks.length}`
  // console.time(lbl2);
  httpTasks.forEach(async (task, index) => {
    try {
      let cache = await (await cachedDatabase).get('profilePhotos', task.photoId);
      if (cache == null) {
        const html = new DOMParser().parseFromString(await (await fetch(task.url)).text(), 'text/html');
        const images = html.getElementsByClassName('tgme_page_photo_image');
        if (images.length === 0) {
          const base64 = await bufferToBase64(await client.downloadProfilePhoto(task.chat));
          await (await cachedDatabase).put('profilePhotos', base64, task.photoId);
          cache = base64;
        } else {
          const img = images[0] as HTMLImageElement;
          const blob = await (await fetch(img.src)).blob()
          const base64 = await blobToBase64(blob);
          await (await cachedDatabase).put('profilePhotos', base64, task.photoId);
          cache = base64;
        }
      }
      updateThumbCached(task.photoId, cache);
    } catch (err) {
      console.log('httpTasks:', err, url);
      websocketTasks.push(task);
    }
  });
  // console.timeEnd(lbl2);

  // const lbl3 = `[NON-BLOCKING]:websocketTasks ${websocketTasks.length}`
  // console.time(lbl3);
  websocketTasks.forEach(async (task) => {
    try {
      let cache = await (await cachedDatabase).get('profilePhotos', task.photoId.toString());
      if (cache != null) {
        updateThumbCached(task.photoId, cache);
      } else {
        if (window['web_worker']) {
          window['web_worker'].postMessage({
            type: 2,
            params: {
              photoId: task.photoId.toString(),
              chatId: task.chat.entity ? task.chat.entity.id.toString() : task.chat.id.toString(),
            }
          });
        }
      }
    } catch (err) {
      console.log('websocketTasks:', err);
    }
  });
  // console.timeEnd(lbl3);
}

export async function updateThumbCached(ref, base64) {
  const cached = await get(cachedThumbnails);
  cached[ref] = base64;
  cachedThumbnails.update(n => cached);
}

export function bufferToBase64(buffer) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      resolve(reader.result);
    };
    reader.onerror = (err) => {
      reject(err);
    };
    reader.readAsDataURL(new Blob([new Uint8Array(buffer, 0, buffer.length)], {type : 'image/jpeg'}));
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      resolve(reader.result);
    };
    reader.onerror = (err) => {
      reject(err);
    };
    reader.readAsDataURL(blob);
  });
}

function runWorker() {
  if (window['web_worker'])
    window['web_worker'].terminate();
  const script = `
    // void 0!==typeof Symbol&&Symbol.asyncIterator||(Symbol.asyncIterator=Symbol.for("Symbol.asyncIterator"));
    importScripts('${window.location.origin}/js/polyfill.min.js');
    importScripts('${window.location.origin}/js/telegram.js');

    let clients;
    let chats = {};
    let downloadMediaTask = [];
    let downloadProfilePhotoTask = [];

    function bufferToBase64(buffer) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          resolve(reader.result);
        };
        reader.onerror = (err) => {
          reject(err);
        };
        reader.readAsDataURL(new Blob([new Uint8Array(buffer, 0, buffer.length)], {type : 'image/jpeg'}));
      });
    }

    function retrieveChats() {
      client.getDialogs({
        offsetPeer: new telegram.Api.InputPeerSelf(),
        limit: 100,
        excludePinned: true,
        folderId: 0,
      })
      .then((result) => {
        for (var x in result) {
          if (result[x].id && result[x].id.value) {
            const id = result[x].id.value.toString();
            chats[id] = result[x];
          }
        }
      })
      .catch(err => {
        self.postMessage({ type: -1, params: err });
      });
    }

    function executeDownloadMediaTask() {
      if (downloadMediaTask.length <= 0)
        return;
      const task = downloadMediaTask[0];
      // console.log(chats[task.chatId], task.chatId, task.messageId);
      client.getMessages(chats[task.chatId].entity, { limit: 1, ids: task.messageId })
      .then((msg) => {
        return client.downloadMedia(msg[0].media);
      })
      .then((bytes) => {
        const hash = task.chatId + task.messageId.toString();
        self.postMessage({ type: 1, hash: hash, result: bytes });
      })
      .catch(err => {
        self.postMessage({ type: -1, params: err });
      })
      .finally(() => {
        setTimeout(() => {
          downloadMediaTask.splice(0, 1);
          executeDownloadMediaTask();
        }, 1500);
      });
    }

    function executeDownloadProfilePhotoTask() {
      if (client.connected === false && downloadProfilePhotoTask.length > 0) {
        setTimeout(() => {
          executeDownloadProfilePhotoTask();
        }, 3000)
        return;
      }
      if (downloadProfilePhotoTask.length <= 0)
        return;
      const task = downloadProfilePhotoTask[0];
      // console.log(task.chatId, task.photoId);
      client.downloadProfilePhoto(telegram.helpers.returnBigInt(task.chatId), { isBig: true })
      .then((buffer) => {
        return bufferToBase64(buffer);
      })
      .then((base64) => {
        self.postMessage({ type: 2, hash: task, result: base64 });
      })
      .catch(err => {
        self.postMessage({ type: -1, params: err });
      })
      .finally(() => {
        setTimeout(() => {
          downloadProfilePhotoTask.splice(0, 1);
          executeDownloadProfilePhotoTask();
        }, 1500);
      });

    }

    self.onmessage = function(e) {
      switch (e.data.type) {
        case 0:
          const session = new telegram.sessions.MemorySession();
          if (e.data.params) {
            session.setDC(e.data.params.dcId, e.data.params.serverAddress, e.data.params.port);
            session.setAuthKey(new telegram.AuthKey(e.data.params.authKey._key, e.data.params.authKey._hash), e.data.params.dcId);
          }
          client = new telegram.TelegramClient(session, ${TelegramKeyHash.api_id}, '${TelegramKeyHash.api_hash}', {
            maxConcurrentDownloads: 1,
          });
          client.addEventHandler((evt) => {
            console.log('worker.client.addEventHandler:', evt.className);
          });
          client.connect()
          .then(() => {
            retrieveChats();
            self.postMessage({ type: e.data.type, params: 1 });
          })
          .catch(err => {
            self.postMessage({ type: -1, params: err });
          });
          break;
        case 1:
          // const chatId = telegram.helpers.returnBigInt(e.data.params.chatId);
          if (chats[e.data.params.chatId]) {
            downloadMediaTask.push(e.data.params);
            if (downloadMediaTask.length === 1)
              executeDownloadMediaTask();
          }
          break;
        case 2:
          // const chatId = telegram.helpers.returnBigInt(e.data.params.chatId);
          downloadProfilePhotoTask.push(e.data.params);
          if (downloadProfilePhotoTask.length === 1)
            executeDownloadProfilePhotoTask();
          break;
      }
    }
  `;
  const blob = new Blob([script], {type: 'application/javascript'});
  const worker = new Worker(URL.createObjectURL(blob));
  worker.postMessage({
    type: 0,
    params: {
      dcId: session.dcId,
      serverAddress: session.serverAddress,
      port: session.port,
      authKey: session.getAuthKey(session.dcId)
    }
  });
  return worker;
}
