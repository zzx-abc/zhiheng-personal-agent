import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const folder=mkdtempSync(path.join(tmpdir(),'zhiheng-ocr-test-'));
process.env.AGENT_DATA_DIR=folder;process.env.AGENT_TEST_MODE='1';
const db=await import('../server/db'),s=await import('../server/library/service'),a=await import('../server/library/assets'),p=await import('../server/library/parse'),ocr=await import('../server/library/ocr'),processor=await import('../server/library/processor');
if(process.platform==='darwin'){const fixture=path.join(folder,'fixture');execFileSync('/usr/bin/xcrun',['clang','-fobjc-arc','scripts/library/ocr-fixture.m','-framework','AppKit','-framework','PDFKit','-o',fixture],{timeout:60000,stdio:'pipe'});execFileSync(fixture,[folder],{timeout:30000,stdio:'pipe'});}
after(()=>{db.db.close();rmSync(folder,{recursive:true,force:true})});
const mac={skip:process.platform!=='darwin',timeout:180000};
test('real Vision recognizes Chinese, codes and numbers with provenance; duplicate assets keep citation IDs',mac,async()=>{
 const bytes=readFileSync(path.join(folder,'synthetic.png')),asset=a.storeAsset(bytes,'application/octet-stream');assert.equal(asset.mime,'image/png');
 const parsed=await p.parseAsset(asset);assert.equal(parsed.state,'ready');assert.match(parsed.chunks.map(c=>c.body).join(''),/需求改善/);assert.match(parsed.chunks[0].body,/123\.45/);assert.match(parsed.chunks[0].locator,/OCR转写/);assert.equal(parsed.info.ocrEngine,ocr.OCR_ENGINE);assert.ok(parsed.info.ocrPages[0].meanConfidence>0);
 const again=await p.parseAsset(asset);assert.deepEqual(again.chunks,parsed.chunks);assert.deepEqual(readFileSync(asset.path),bytes);
 const jpeg=a.storeAsset(readFileSync(path.join(folder,'synthetic.jpg')),'image/png');assert.equal(jpeg.mime,'image/jpeg');assert.equal((await p.parseAsset(jpeg)).state,'ready');
});
test('scanned PDF preserves physical page and explicitly reports blank page',mac,async()=>{
 const asset=a.storeAsset(readFileSync(path.join(folder,'scanned.pdf')),'application/pdf');const raw=await p.pdfText(readFileSync(asset.path));assert.equal(raw.pages.length,0);
 const parsed=await p.parseAsset(asset);assert.equal(parsed.state,'partial');assert.deepEqual(parsed.info.unreadPages,[2]);assert.deepEqual(parsed.info.ocrRemainingPages,[]);assert.match(parsed.chunks[0].locator,/PDF物理页1.*OCR/);assert.match(parsed.chunks[0].body,/600001/);
 const cached=await p.parseAsset(asset);assert.deepEqual(cached.chunks,parsed.chunks);assert.equal(cached.info.ocrPages.length,2);
});
test('long scans continue after ten pages without replacing older citations or repeating pages',mac,async()=>{
 const asset=a.storeAsset(readFileSync(path.join(folder,'long-scan.pdf')),'application/pdf');const first=await p.parseAsset(asset);assert.equal(first.state,'partial');assert.deepEqual(first.info.ocrRemainingPages,[11]);assert.equal(first.info.ocrPages.length,10);
 const second=await p.parseAsset(asset);assert.equal(second.state,'ready');assert.equal(second.info.ocrPages.length,11);assert.equal(second.chunks.length,11);assert.deepEqual(second.chunks.slice(0,10),first.chunks);assert.match(second.chunks[10].locator,/物理页11/);
});
test('legacy unsupported image upgrades on retry and OCR text enters retrieval without fabricated AI',mac,async()=>{
 const key=s.ingest({files:[{name:'Synthetic source.png',mime:'image/png',bytes:readFileSync(path.join(folder,'synthetic.png'))}],intent:'collect',eventKey:db.id()}).entryIds[0];
 const e=s.entry(key);db.exec("UPDATE library_assets SET parse_state='unsupported',parse_info='{}' WHERE id=?",e.asset_id);db.exec('DELETE FROM library_chunks WHERE asset_id=?',e.asset_id);
 const r=db.one<any>('SELECT r.* FROM runs r JOIN library_jobs j ON r.id=j.run_id WHERE j.entry_id=?',key)!;db.exec("UPDATE runs SET status='running' WHERE id=?",r.id);
 await processor.processLibrary({...r,status:'running'},async()=>({items:[]}));assert.equal(s.entry(key).parse_state,'ready');assert.equal((await s.search('需求改善')).results[0].id,key);assert.equal(s.detail(key).claims.length,0);
 s.annotate(key,'测试纠正：原图数字应以原件核对，不视为事实','correction');assert.equal(s.entry(key).version,2);assert.match((await s.search('测试纠正')).results[0].excerpt,/测试纠正/);
 const original=db.one<any>('SELECT path FROM library_assets WHERE id=?',e.asset_id)!.path;s.deleteEntry(key,2);assert.equal(existsSync(original),false);assert.equal(db.one('SELECT id FROM library_chunks WHERE asset_id=?',e.asset_id),undefined);
});
test('cancelled OCR cannot save chunks and corrupt images keep honest failure state',mac,async()=>{
 const bad=a.storeAsset(Buffer.from('not an image'),'image/png');const cancelled=new AbortController();cancelled.abort();await assert.rejects(p.parseAsset(bad,'',cancelled.signal));assert.equal(db.all('SELECT id FROM library_chunks WHERE asset_id=?',bad.id).length,0);
 const parsed=await p.parseAsset(bad);assert.equal(parsed.state,'unsupported');assert.equal(parsed.chunks.length,0);assert.ok(parsed.info.ocrError);assert.ok(existsSync(bad.path));
});

test('deleting during live OCR cancels output instead of resurrecting the saved source',mac,async()=>{
 await ocr.ensureOcr();const bytes=Buffer.concat([readFileSync(path.join(folder,'synthetic.png')),Buffer.from('synthetic cancellation case')]);
 const key=s.ingest({files:[{name:'SYNTHETIC-cancel.png',mime:'image/png',bytes}],intent:'collect',eventKey:db.id()}).entryIds[0],asset=db.one<any>('SELECT * FROM library_assets WHERE id=?',s.entry(key).asset_id)!;
 const controller=new AbortController();const running=p.parseAsset(asset,'',controller.signal);const timer=setTimeout(()=>{s.deleteEntry(key,1);controller.abort()},10);
 try{await assert.rejects(running);assert.equal(db.one('SELECT id FROM library_assets WHERE id=?',asset.id),undefined);assert.equal(db.all('SELECT * FROM library_chunks WHERE asset_id=?',asset.id).length,0);}finally{clearTimeout(timer)}
});
