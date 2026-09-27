import { test, expect } from '@playwright/test';
test('本地初始化、单机、离线、双人联机、管理资产及手机布局',async({browser,page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  // Keep bot choices repeatable; production deck randomness still uses crypto.
  await page.addInitScript(()=>{Math.random=()=>0.5;});
  await page.goto('/');await expect(page.getByRole('heading',{name:'欢迎开馆'})).toBeVisible();
  await page.getByLabel('用户名',{exact:true}).fill('owner');await page.getByLabel('昵称',{exact:true}).fill('馆主');await page.getByLabel('密码（至少 8 位）').fill('Owner-pass-123');await page.getByRole('button',{name:'创建管理员并进入'}).click();
  await expect(page.getByRole('heading',{name:'好久不见，来一局？'})).toBeVisible();await expect(page.locator('.nickname')).toHaveText('馆主');
  await page.screenshot({path:'test-results/home-desktop.png',fullPage:true});
  await page.getByRole('button',{name:'练习设置'}).click();await page.getByLabel('机器人数量').selectOption('1');await page.getByRole('button',{name:'开始练习',exact:true}).click();
  await expect(page.locator('.gameboard')).toBeVisible();await expect(page.getByRole('button',{name:'看牌',exact:true})).toBeVisible({timeout:10000});await page.getByRole('button',{name:'看牌',exact:true}).click();await expect(page.locator('.seat.mine .playing-card:not(.back)')).toHaveCount(3);
  await page.screenshot({path:'test-results/table-desktop.png',fullPage:true});
  await page.getByRole('button',{name:'弃牌',exact:true}).click();await expect(page.getByText('一局结束，再接再厉')).toBeVisible();
  await page.evaluate(()=>navigator.serviceWorker.ready);await page.reload();await page.context().setOffline(true);await page.reload();await page.locator('button[data-page="practice"]').click();await expect(page.locator('.gameboard')).toBeVisible();await page.context().setOffline(false);
  await page.goto('/');await expect(page.locator('.nickname')).toHaveText('馆主');
  const c2=await browser.newContext(),p2=await c2.newPage();p2.on('pageerror',e=>errors.push(e.message));await p2.goto('http://127.0.0.1:3101');await p2.getByRole('button',{name:'登录 / 注册'}).click();await p2.getByRole('button',{name:'还没账号？注册一个'}).click();await p2.getByLabel('用户名',{exact:true}).fill('friend');await p2.getByLabel('昵称',{exact:true}).fill('小鹿');await p2.getByLabel('密码（至少 8 位）').fill('Friend-pass-123');await p2.getByRole('button',{name:'注册并登录'}).click();await expect(p2.locator('.nickname')).toHaveText('小鹿');
  await page.getByRole('button',{name:'创建好友牌桌'}).click();await page.getByRole('button',{name:'创建房间',exact:true}).click();await expect(page.locator('.room-code')).toBeVisible();const code=await page.locator('.room-code').innerText();
  await p2.getByRole('button',{name:'输入房间码'}).click();await p2.getByLabel('6 位房间码').fill(code);await p2.getByRole('button',{name:'加入房间',exact:true}).click();await expect(p2.locator('.room-code')).toHaveText(code);
  await page.getByRole('button',{name:'准备开局',exact:true}).click();await p2.getByRole('button',{name:'准备开局',exact:true}).click();await expect(page.locator('.gameboard')).toBeVisible({timeout:10000});await expect(p2.getByRole('button',{name:'看牌',exact:true})).toBeVisible();await expect(page.locator('.seat .playing-card:not(.back)')).toHaveCount(0);
  await p2.getByRole('button',{name:'看牌',exact:true}).click();await expect(p2.locator('.seat.mine .playing-card:not(.back)')).toHaveCount(3);await expect(page.locator('.seat .playing-card:not(.back)')).toHaveCount(0);await p2.getByRole('button',{name:'弃牌',exact:true}).click();await expect(page.getByText('好牌！你赢下了这一局')).toBeVisible();
  await p2.getByRole('button',{name:'离开房间',exact:true}).click();await p2.getByRole('button',{name:'确认离开',exact:true}).click();await expect(p2.locator('.wallet-pill')).toContainText('9,990');
  await page.locator('button[data-page="admin"]').click();await page.getByRole('button',{name:'调账',exact:true}).click();await page.getByLabel('变更金额（例如 1000 或 -500）').fill('500');await page.getByLabel('操作原因').fill('本地验收发放');await page.getByRole('button',{name:'确认调账',exact:true}).click();await expect(p2.locator('.wallet-pill')).toContainText('10,490');await page.screenshot({path:'test-results/admin-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.locator('button[data-page="home"]').click();await page.screenshot({path:'test-results/home-mobile.png',fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  expect(await page.locator('.brand strong').evaluate(e=>e.getBoundingClientRect().height)).toBeLessThan(30);
  await page.locator('button[data-page="practice"]').click();await page.screenshot({path:'test-results/table-mobile.png',fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  expect(errors).toEqual([]);await c2.close();
});
