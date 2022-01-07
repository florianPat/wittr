import Server from './Server.js';
import Settings from './Settings.js';
import minimist from 'minimist';

const argv = minimist(process.argv, {
  'default': {
    'config-server-port': 8889,
    'server-port': 8888
  }
});
const server = new Server(argv['server-port']);
const settings = new Settings(argv['config-server-port'], argv['server-port']);

settings.listen();
server.setConnectionType('perfect');

settings.on('connectionChange', ({type}) => {
  server.setConnectionType(type);
});
