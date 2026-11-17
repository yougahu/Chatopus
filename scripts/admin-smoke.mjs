import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const require=createRequire(import.meta.url);
let chromium;
try {
 ({chromium}=require(process.env.ADMIN_SMOKE_PLAYWRIGHT_MODULE??'playwright'));
 if(!chromium?.launch)throw new Error('The selected module does not export chromium.launch');
} catch(error) {
 throw new Error('Admin smoke requires an existing Playwright installation. Set ADMIN_SMOKE_PLAYWRIGHT_MODULE to its package path. This script does not install dependencies.',{cause:error});
}
const target=new URL(process.env.ADMIN_SMOKE_BASE_URL??'http://127.0.0.1:8092/');
if(!['http:','https:'].includes(target.protocol)||target.username||target.password)throw new Error('ADMIN_SMOKE_BASE_URL must be an HTTP(S) URL without embedded credentials');
const timeout=Number(process.env.ADMIN_SMOKE_TIMEOUT_MS??30000);
if(!Number.isSafeInteger(timeout)||timeout<1||timeout>120000)throw new Error('ADMIN_SMOKE_TIMEOUT_MS must be 1..120000');
const browser=await chromium.launch({headless:true,...(process.env.ADMIN_SMOKE_CHROMIUM_EXECUTABLE
 ?{executablePath:resolve(process.env.ADMIN_SMOKE_CHROMIUM_EXECUTABLE)}:{channel:process.env.ADMIN_SMOKE_BROWSER_CHANNEL??'chrome'})});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
page.setDefaultTimeout(timeout);
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const dir=resolve(process.env.ADMIN_SMOKE_OUTPUT_DIR??'.runtime/verification/admin');mkdirSync(dir,{recursive:true});
try{
 await page.goto(target.href);
 await page.getByText('没有已记录的异常。').waitFor();
 const sources=await page.locator('#source option').evaluateAll(nodes=>nodes.map(n=>({value:n.value,text:n.textContent})));
 if(sources.length>1){await page.selectOption('#source',sources[1].value);await page.waitForTimeout(400);}
 await page.screenshot({path:resolve(dir,'overview.png'),fullPage:true});
 await page.locator('nav [data-view="threads"]').click();
 await page.getByRole('button',{name:'追踪',exact:true}).first().waitFor();
 await page.screenshot({path:resolve(dir,'threads.png'),fullPage:true});
 await page.getByRole('button',{name:'追踪',exact:true}).first().click();
 await page.locator('#detail[open]').waitFor();
 const detail=await page.locator('#detail-body').textContent();
 if(!detail?.trim())throw Error('Thread audit is empty; supply a local fixture with a recorded Worker run');
 if(process.env.ADMIN_SMOKE_EXPECTED_SOURCE&&!detail.includes(process.env.ADMIN_SMOKE_EXPECTED_SOURCE))throw Error('Thread audit does not contain ADMIN_SMOKE_EXPECTED_SOURCE');
 await page.getByRole('button',{name:'查看该 Worker 的工具轨迹'}).click();
 await page.waitForFunction(()=>document.querySelector('#detail-body')?.textContent.includes('tool/'));
 await page.screenshot({path:resolve(dir,'trace.png'),fullPage:true});
 await page.getByRole('button',{name:'关闭',exact:true}).click();
 await page.locator('nav [data-view="config"]').click();await page.getByText('运行配置（凭据已隐藏）').waitFor();
 const configText=await page.locator('#content').textContent();if(configText.includes('sk-'))throw Error('Credential leaked');
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:resolve(dir,'mobile.png'),fullPage:true});
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+2);if(overflow)throw Error('Mobile horizontal overflow');
 if(errors.length)throw Error('Browser errors: '+errors.join(','));
 writeFileSync(resolve(dir,'result.json'),JSON.stringify({time:new Date().toISOString(),passed:true,sources:sources.length,checks:['direct access without token','overview','thread source and result','native tool trace','config credentials hidden','mobile viewport','no console errors']},null,2));
 console.log('Admin browser verification passed');
}catch(error){
 writeFileSync(resolve(dir,'result.json'),JSON.stringify({time:new Date().toISOString(),passed:false,error:String(error)},null,2));
 throw error;
}finally{await browser.close();}
