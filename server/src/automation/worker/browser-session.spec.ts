import assert from 'node:assert/strict';
import {test} from 'node:test';
import net from 'node:net';
import {BrowserSession} from './browser-session.js';
import {ProcessExecutor} from '../runners/process-executor.js';
import {ExecutionScope} from '../runners/execution-scope.js';

test('managed browser server becomes ready on isolated port and closes its child process', async () => {
  const probe=net.createServer();await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=(probe.address() as net.AddressInfo).port;await new Promise<void>(resolve=>probe.close(()=>resolve()));
  await ExecutionScope.run({env:{...process.env,PORT:String(port)}},async()=>{
    const browser=new BrowserSession();const progress:string[]=[];
    try {
      const url=await browser.start({command:process.execPath,args:['-e',"require('http').createServer((q,r)=>r.end('ready')).listen(Number(process.env.PORT),'127.0.0.1')"],readyPath:'/'},process.cwd(),AbortSignal.timeout(15000),new ProcessExecutor(),text=>progress.push(text));
      assert.equal(await (await fetch(url)).text(),'ready');assert.match(progress.join(''),/startupMs=/);
    } finally {await browser.close();}
    await assert.rejects(fetch(`http://127.0.0.1:${port}`));
  });
});
test('managed browser rejects an application that exits and cleans up', async()=>{
  const browser=new BrowserSession();
  try { await ExecutionScope.run({env:{...process.env,PORT:'1'}},()=>assert.rejects(browser.start({command:process.execPath,args:['-e','process.exit(2)'],readyPath:'/'},process.cwd(),AbortSignal.timeout(10000),new ProcessExecutor(),()=>{}),/exited/)); }
  finally {await browser.close();}
});
