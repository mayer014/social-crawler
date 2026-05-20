const { chromium } = require('playwright');

(async () => {

  console.log('Iniciando crawler...');

  const browser = await chromium.launch({
    headless: true
  });

  const page = await browser.newPage();

  await page.goto('https://instagram.com/juniorcoringa/', {
    waitUntil: 'networkidle'
  });

  console.log('Página carregada');

  const title = await page.title();

  console.log('Título:', title);

  await page.screenshot({
    path: 'teste.png'
  });

  console.log('Screenshot salva');

  setInterval(() => {
    console.log('Crawler ativo...');
  }, 30000);

})();
