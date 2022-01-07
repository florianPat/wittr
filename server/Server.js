import express from 'express';
import zlib from 'zlib';
import fs from 'fs';
import path from 'path';
import os from 'os';
import compression from 'compression';
import {WebSocketServer} from 'ws';
import http from 'http';
import url from 'url';
import net from 'net';
import Throttle from 'throttle';
import number  from 'lodash/number.js';
const random = number.random;
import indexTemplate from './templates/index.js';
import postsTemplate from './templates/posts.js';
import postTemplate from './templates/post.js';
import remoteExecutorTemplate from './templates/remote-executor.js';
import idbTestTemplate from './templates/idb-test.js';
import {generateReady, generateMessage} from './generateMessage.js';

const maxMessages = 30;

const compressor = compression({
  flush: zlib.Z_PARTIAL_FLUSH
});

const appServerPath = os.platform() == 'win32' ?
  '\\\\.\\pipe\\offlinefirst' + Date.now() + '.sock' :
  'offlinefirst.sock';

const connectionProperties = {
  perfect: {bps: 100000000, delay: 0},
  slow: {bps: 4000, delay: 3000},
  'lie-fi': {bps: 1, delay: 10000}
};

const imgSizeToFlickrSuffix = {
  '1024px': 'b',
  '800px': 'c',
  '640px': 'z',
  '320px': 'n'
};

function findIndex(arr, func) {
  for (let i = 0; i < arr.length; i++) {
    if (func(arr[i], i, arr)) return i;
  }
  return -1;
}

export default class Server {
  constructor(port) {
    this._app = express();
    this._messages = [];
    this._sockets = [];
    this._serverUp = false;
    this._appServerUp = false;
    this._port = port;
    this._connectionType = '';
    this._connections = [];

    this._appServer = http.createServer(this._app);
    this._exposedServer = net.createServer();

    this._wss = new WebSocketServer({
      server: this._appServer,
      path: '/updates'
    });

    const staticOptions = {
      maxAge: 0
    };

    this._exposedServer.on('connection', socket => this._onServerConnection(socket));
    this._wss.on('connection', (ws, req) => this._onWsConnection(ws, req.url));

    this._app.use(compressor);
    this._app.use('/js', express.static('../public/js', staticOptions));
    this._app.use('/css', express.static('../public/css', staticOptions));
    this._app.use('/imgs', express.static('../public/imgs', staticOptions));
    this._app.use('/avatars', express.static('../public/avatars', staticOptions));
    this._app.use('/sw.js', (req, res) => res.sendFile(path.resolve('../public/sw.js'), staticOptions));
    this._app.use('/sw.js.map', (req, res) => res.sendFile(path.resolve('../public/sw.js.map'), staticOptions));
    this._app.use('/manifest.json', (req, res) => res.sendFile(path.resolve('../public/manifest.json'), staticOptions));

    this._app.get('/', (req, res) => {
      res.send(indexTemplate({
        scripts: '<script src="/js/main.js" defer></script>',
        content: postsTemplate({
          content: this._messages.map(item => postTemplate(item)).join('')
        })
      }));
    });

    this._app.get('/skeleton', (req, res) => {
      res.send(indexTemplate({
        scripts: '<script src="/js/main.js" defer></script>',
        content: postsTemplate()
      }));
    });

    this._app.get('/photos/:url', (req, res) => {
      const flickrUrl = `http://images.unsplash.com/${req.params.url}`;
      const flickrRequest = http.request(flickrUrl, flickrRes => {
        flickrRes.pipe(res);
      });

      flickrRequest.on('error', err => {
        const __dirname = path.resolve();
        res.sendFile('imgs/icon.png', {
          root: __dirname + '/../public/'
        });
      });

      flickrRequest.end();
    });

    this._app.get('/ping', (req, res) => {
      res.set('Access-Control-Allow-Origin', '*');
      res.status(200).send({ok: true});
    });

    this._app.get('/remote', (req, res) => {
      res.send(remoteExecutorTemplate());
    });

    this._app.get('/idb-test/', (req, res) => {
      res.send(idbTestTemplate());
    });

    generateReady.then(_ => {
      // generate initial messages
      let time = new Date();

      for (let i = 0; i < maxMessages; i++) {
        const msg = generateMessage();
        const timeDiff = random(5000, 15000);
        time = new Date(time - timeDiff);
        msg.time = time.toISOString();
        this._messages.push(msg);
      }

      this._generateDelayedMessages();
    });
  }

  _generateDelayedMessages() {
    setTimeout(_ => {
      this._addMessage();
      this._generateDelayedMessages();
    }, random(5000, 15000));
  }

  _broadcast(obj) {
    const msg = JSON.stringify(obj);
    this._sockets.forEach(socket => {
      socket.send(msg, (err) => {
        if (err) console.error(err);
      });
    });
  }

  _onServerConnection(socket) {
    let closed = false;
    this._connections.push(socket);

    socket.on('close', _ => {
      closed = true;
      this._connections.splice(this._connections.indexOf(socket), 1);
    });

    socket.on('error', err => console.log(err));

    const connection = connectionProperties[this._connectionType];
    const makeConnection = _ => {
      if (closed) return;
      const appSocket = net.connect(appServerPath);
      appSocket.on('error', err => console.log(err));
      socket.pipe(new Throttle(connection.bps)).pipe(appSocket);
      appSocket.pipe(new Throttle(connection.bps)).pipe(socket);
    };

    if (connection.delay) {
      setTimeout(makeConnection, connection.delay);
      return;
    }
    makeConnection();
  }

  _onWsConnection(socket, requestUrlString) {
    const requestUrl = url.parse(requestUrlString, true);

    if ('no-socket' in requestUrl.query) return;

    this._sockets.push(socket);

    socket.on('close', _ => {
      this._sockets.splice(this._sockets.indexOf(socket), 1);
    });

    let sendNow = [];

    if (requestUrl.query.since) {
      const sinceDate = new Date(Number(requestUrl.query.since));
      let missedMessages = findIndex(this._messages, msg => new Date(msg.time) <= sinceDate);
      if (missedMessages == -1) missedMessages = this._messages.length;
      sendNow = this._messages.slice(0, missedMessages);
    }
    else {
      sendNow = this._messages.slice();
    }

    if (sendNow.length) {
      socket.send(JSON.stringify(sendNow));
    }
  }

  _addMessage() {
    const message = generateMessage();
    this._messages.unshift(message);
    this._messages.pop();
    this._broadcast([message]);
  }

  _listen() {
    this._serverUp = true;
    this._exposedServer.listen(this._port, _ => {
      console.log("Server listening at localhost:" + this._port);
    });

    if (!this._appServerUp) {
      if (fs.existsSync(appServerPath)) fs.unlinkSync(appServerPath);
      this._appServer.listen(appServerPath);
      this._appServerUp = true;
    }
  }

  _destroyConnections() {
    this._connections.forEach(c => c.destroy());
  }

  setConnectionType(type) {
    if (type === this._connectionType) return;
    this._connectionType = type;
    this._destroyConnections();

    if (type === 'offline') {
      if (!this._serverUp) return;
      this._exposedServer.close();
      this._serverUp = false;
      return;
    }

    if (!this._serverUp) {
      this._listen();
    }
  }
}
