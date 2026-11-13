// One slot per lane. No Promise.all over the queue: memory/model concurrency remains bounded.
export class WorkerLanes {
 private pending=new Map<string,Promise<void>>();
 launch(name:string,work:()=>Promise<void>,failed:(error:unknown)=>void=()=>{}){if(this.pending.has(name))return false;const task=Promise.resolve().then(work).catch(failed).finally(()=>this.pending.delete(name));this.pending.set(name,task);return true;}
 busy(name:string){return this.pending.has(name);}
 async drain(){await Promise.all([...this.pending.values()]);}
}
