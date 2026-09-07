const { chromium } = require('playwright');
const axios = require('axios');

(async () => {
  console.log('🚀 啟動無頭瀏覽器...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  // 設定操作超時上限，避免無限等待
  page.setDefaultTimeout(10000);

  // 進入台南 BodyCombat 查詢頁
  const targetUrl = 'https://www.worldgymtaiwan.com/aerobics-schedule-search?city_code=67&class_uid=AB0060001#query_result';
  console.log('🌐 正在開啟查詢頁面...');
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // 抽取單週課表的共用函式
  const extractCurrentWeek = async () => {
    return await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('#schedule_area .class_list'));
      if (!cards.length) return { courses: [], weekRange: "" };

      // 支援常規格式 (9月 7-13, 2026) 與跨月格式 (9月 28-10月 4, 2026)
      const text = document.body.innerText;
      const match = text.match(/(\d{1,2})月\s*(\d{1,2})\s*[-~至]\s*(?:(\d{1,2})月\s*)?(\d{1,2}),?\s*(\d{4})/);
      
      let baseMonday;
      let weekRange = "";
      if (match) {
        const startMonth = parseInt(match[1], 10);
        const startDay = parseInt(match[2], 10);
        const year = parseInt(match[5], 10);
        weekRange = `${year}-${String(startMonth).padStart(2, '0')}-${String(startDay).padStart(2, '0')}`;
        baseMonday = new Date(year, startMonth - 1, startDay);
      } else {
        return { courses: [], weekRange: "" };
      }

      const xPositions = cards.map(c => Math.round(c.getBoundingClientRect().left));
      const minX = Math.min(...xPositions);
      const maxX = Math.max(...xPositions);
      const colWidth = (maxX - minX) / 6 || 1;

      const list = [];
      cards.forEach(card => {
        const rect = card.getBoundingClientRect();
        const dayOffset = Math.max(0, Math.min(6, Math.round((rect.left - minX) / colWidth)));
        
        const courseDate = new Date(baseMonday);
        courseDate.setDate(courseDate.getDate() + dayOffset);
        
        const yyyy = courseDate.getFullYear();
        const mm = String(courseDate.getMonth() + 1).padStart(2, '0');
        const dd = String(courseDate.getDate()).padStart(2, '0');
        const dateStr = `${yyyy}-${mm}-${dd}`;

        const timeEl = card.querySelector('.newclass_time');
        let start = "", end = "";
        if (timeEl) {
          const parts = timeEl.innerText.replace(/\s+/g, '').split('|');
          start = parts[0] || "";
          end = parts[1] || "";
        }

        const storeEl = card.querySelector('.class_store');
        const branch = storeEl ? storeEl.innerText.replace('台南', '').replace('店', '').trim() : "";

        const teacherEl = card.querySelector('.teacher');
        let teacher = teacherEl ? teacherEl.innerText.trim() : "";
        if (card.innerText.includes('代課') && !teacher.includes('代課')) {
          teacher += " (代課)";
        }

        if (start && branch) {
          list.push({ date: dateStr, start, end, branch, teacher });
        }
      });

      return { courses: list, weekRange };
    });
  };

  // 等待課表區域載入
  await page.waitForSelector('#schedule_area', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // ----------------------------------------------------
  // 步驟一：回溯至最早的歷史週次
  // ----------------------------------------------------
  console.log('⏪ 正在回溯至最早的上一週/歷史週...');
  for (let step = 0; step < 4; step++) {
    const prevBtn = await page.$('button.slick-prev');
    if (!prevBtn) break;

    const isPrevDisabled = await page.evaluate(el => el.classList.contains('slick-disabled') || el.disabled, prevBtn);
    if (isPrevDisabled) {
      console.log('📌 已抵達最早週次 (無法再上一週)。');
      break;
    }

    try {
      console.log('👈 點擊前往上一週...');
      await prevBtn.click({ timeout: 3000 });
      await page.waitForTimeout(1500);
    } catch (e) {
      console.log('⚠️ 上一週點擊未響應，停止回溯。');
      break;
    }
  }

  // ----------------------------------------------------
  // 步驟二：由最早週一路往後抓取所有開放週次
  // ----------------------------------------------------
  const allCourses = [];
  const visitedWeeks = new Set();

  for (let week = 1; week <= 10; week++) {
    await page.waitForTimeout(1200);
    const weekData = await extractCurrentWeek();

    console.log(`🔎 抓取週次 [${weekData.weekRange}]，課程數 ${weekData.courses.length} 筆`);

    if (weekData.weekRange && !visitedWeeks.has(weekData.weekRange)) {
      visitedWeeks.add(weekData.weekRange);
      allCourses.push(...weekData.courses);
    }

    // 檢查「下一週」按鈕
    const nextBtn = await page.$('button.slick-next');
    if (!nextBtn) break;

    const isNextDisabled = await page.evaluate(el => el.classList.contains('slick-disabled') || el.disabled, nextBtn);
    if (isNextDisabled) {
      console.log('📌 已抵達最末週次 (無法再下一週)，掃描完成！');
      break;
    }

    try {
      console.log('👉 點擊前往下一週...');
      await nextBtn.click({ timeout: 3000 });
      await page.waitForTimeout(1500);
    } catch (e) {
      console.log('⚠️ 下一週點擊未響應，結束翻頁。');
      break;
    }
  }

  await browser.close();

  // 去重並按日期與時間排序
  const uniqueMap = new Map();
  allCourses.forEach(c => uniqueMap.set(`${c.date}_${c.start}_${c.branch}`, c));
  const finalCourses = Array.from(uniqueMap.values()).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));

  console.log(`✅ 全程掃描結束！共獲取 ${finalCourses.length} 堂真實課程（涵蓋歷史與未來週數）！`);

  // 推送至 Google 試算表
  const gasUrl = process.env.GAS_WEBAPP_URL;
  if (!gasUrl) {
    console.error('❌ 未設定 GAS_WEBAPP_URL！');
    process.exit(1);
  }

  console.log('📤 正在寫入 Google 試算表...');
  const res = await axios.post(gasUrl, {
    secret: "WG_SECRET_TOKEN_2026",
    courses: finalCourses
  }, { timeout: 20000 });

  console.log('🎉 試算表同步結果：', res.data);
})();
