import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRoomRegistry,git} from '../room-registry.mjs';
const appRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const registry=createRoomRegistry({file:path.join(appRoot,'.runtime','rooms.json'),defaultRoom:{id:'platform',name:'IDEAS · 회의실 앱 개발',root:appRoot,kind:'platform',repo:'https://github.com/gggeunyoung/IDEAS'}});
const [action,name,root]=process.argv.slice(2);
if(action==='add'&&name&&root){const room=await registry.register({name,root,repo:await git(root,['remote','get-url','origin'])});console.log(JSON.stringify(room));}
else if(action==='list')console.log(JSON.stringify(await registry.all(),null,2));
else throw new Error('사용법: node scripts/rooms.mjs add "회의실 이름" /absolute/project/path 또는 list');
