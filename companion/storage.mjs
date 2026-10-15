import {mkdir,readFile,writeFile,rename,lstat,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';

export const defaultDirectory=()=>join(process.env.LOCALAPPDATA || join(homedir(),'.local','share'),'LeetCodeAISidebar','chatgpt');
export async function prepareDirectory(directory){
  await mkdir(directory,{recursive:true,mode:0o700});
  const stat=await lstat(directory);
  if(!stat.isDirectory() || stat.isSymbolicLink())throw new Error('凭据目录必须是普通目录。');
  if(process.platform==='win32'){
    // Windows ignores POSIX modes. Protect inherited access before creating secrets.
    const sid=execFileSync('whoami.exe',['/user','/fo','csv','/nh'],{encoding:'utf8',windowsHide:true}).match(/S-1-5-\d+(?:-\d+)+/)?.[0];
    if(!sid)throw new Error('无法确认当前 Windows 用户，未保存凭据。');
    execFileSync('icacls.exe',[directory,'/inheritance:r','/grant:r',`*${sid}:(OI)(CI)F`,'*S-1-5-18:(OI)(CI)F'],{stdio:'pipe',windowsHide:true});
  }
}
export async function writePrivate(path,value){
  const temp=path+'.'+randomUUID()+'.tmp';
  try{await writeFile(temp,JSON.stringify(value),{flag:'wx',mode:0o600});await rename(temp,path);}
  finally{await rm(temp,{force:true});}
}
const pendingWrites=new Map();
export class Store {
  constructor(directory=defaultDirectory()){this.directory=resolve(directory);this.path=join(this.directory,'accounts.json');}
  async load(){
    try{
      const stat=await lstat(this.path);
      if(!stat.isFile() || stat.isSymbolicLink() || (process.platform!=='win32' && (stat.mode&0o077)))throw new Error('凭据文件权限异常。');
      const data=JSON.parse(await readFile(this.path,'utf8'));
      if(data.version!==1 || !Array.isArray(data.profiles) || typeof data.hostId!=='string')throw new Error('登录文件格式错误，未覆盖现有凭据。');
      return data;
    }catch(e){if(e.code==='ENOENT')return {version:1,hostId:`urn:uuid:${randomUUID()}`,activeProfileId:null,profiles:[]};throw e;}
  }
  transact(fn){
    const task=(pendingWrites.get(this.path) || Promise.resolve()).catch(()=>{}).then(async()=>{const data=await this.load(),result=await fn(data);await writePrivate(this.path,data);return result;});
    pendingWrites.set(this.path,task);
    task.finally(()=>{if(pendingWrites.get(this.path)===task)pendingWrites.delete(this.path);}).catch(()=>{});
    return task;
  }
}
