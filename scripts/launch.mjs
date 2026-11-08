import {spawn} from 'node:child_process';
import {loadEnvFile} from 'node:process';
try{loadEnvFile('.env.local')}catch{}
const mode=process.argv[2]||'dev';const port=process.env.PORT||'3210';
const children=[spawn(process.execPath,['node_modules/next/dist/bin/next',mode,'--hostname','127.0.0.1','--port',port],{stdio:'inherit',env:process.env}),spawn(process.execPath,['--import','tsx','server/worker.ts'],{stdio:'inherit',env:process.env})];
let closing=false;function stop(code=0){if(closing)return;closing=true;for(const child of children)child.kill('SIGTERM');setTimeout(()=>{for(const child of children)child.kill('SIGKILL');process.exit(typeof code==='number'?code:0)},1500).unref();}
process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());for(const child of children)child.on('exit',code=>{if(!closing)stop(code||0)});
