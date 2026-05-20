const { chromium } = require('playwright');

(async () => {

  console.log('Iniciando crawler...');

  const browser = await chromium.launch({
    headless: true
  });

  const page = await browser.newPage();

  await page.goto('https://instagram.com');

  console.log(await page.title());

  await browser.close();

})();
