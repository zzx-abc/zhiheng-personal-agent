import { backup } from 'node:sqlite';
import {mkdirSync,cpSync,existsSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {db,dataDir,now} from '../server/db';
async function main(){const target=path.join(process.cwd(),'backups',new Date().toISOString().replace(/[:.]/g,'-'));mkdirSync(target,{recursive:true,mode:0o700});await backup(db,path.join(target,'agent.sqlite'));for(const folder of ['attachments','library-assets'])if(existsSync(path.join(dataDir,folder)))cpSync(path.join(dataDir,folder),path.join(target,folder),{recursive:true});writeFileSync(path.join(target,'BACKUP.json'),JSON.stringify({createdAt:now(),credentialsIncluded:false,note:'本机备份不是异地备份；删除数据后请同时处理历史备份。'}));console.log('备份已创建（不含 API Key）：'+target);db.close();}main();
