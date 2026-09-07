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
  page.setDefaultTimeout(10000);

  // 查詢網址清單 (若有多個網址可陸續加入)
  const targetUrls = [
    'https://www.worldgymtaiwan.com/aerobics-schedule-search?city_code=67&class_uid=AB0060001#query_result'
  ];

  const extractCurrentWeek = async () => {
    return await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('#schedule_area .class_list'));
      if (!cards.length) return { courses: [], weekRange: "" };

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

        // 1. 時間
        const timeEl = card.querySelector('.newclass_time');
        let start = "", end = "";
        if (timeEl) {
          const parts = timeEl.innerText.replace(/\s+/g, '').split('|');
          start = parts[0] || "";
          end = parts[1] || "";
        }

        // 2. 分店
        const storeEl = card.querySelector('.class_store');
        const branch = storeEl ? storeEl.innerText.replace('台南', '').replace('店', '').trim() : "";

        // 3. 老師 (含代課標註)
        const teacherEl = card.querySelector('.teacher');
        let teacher = teacherEl ? teacherEl.innerText.trim() : "";
        if (card.innerText.includes('代課') && !teacher.includes('代課')) {
          teacher += " (代課)";
        }

        // 4. 課程名稱 (從卡片行文字或 class 提取，預設 BODYCOMBAT®)
        let className = "BODYCOMBAT®";
        const lines = card.innerText.split('\n').map(s => s.trim()).filter(Boolean);
        // 通常第一行為時間，第二行為課程名稱 (例如 BODYCOMBAT® 或 BODYPUMP®)
        if (lines.length >= 2 && !lines[1].includes('店') && !lines[1].includes(':')) {
          className = lines[1];
        }

        if (start && branch) {
          list.push({ date: dateStr, start, end, branch, teacher, className });
        }
      });

      return { courses: list, weekRange };
    });
  };

  const allCourses = [];

  for (let u = 0; u < targetUrls.length; u++) {
    const currentUrl = targetUrls[u];
    console.log(`\n🌐 [${u + 1}/${targetUrls.length}] 正在抓取：${currentUrl}`);

    try {
      await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector('#schedule_area', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);

      // 回溯上一週
      for (let step = 0; step < 4; step++) {
        const prevBtn = await page.$('button.slick-prev');
        if (!prevBtn) break;
        const isDisabled = await page.evaluate(el => el.classList.contains('slick-disabled') || el.disabled, prevBtn);
        if (isDisabled) break;

        try {
          await prevBtn.click({ timeout: 3000 });
          await page.waitForTimeout(1500);
        } catch (e) {
          break;
        }
      }

      // 由前往後抓取
      const visitedWeeks = new Set();
      for (let week = 1; week <= 10; week++) {
        await page.waitForTimeout(1200);
        const weekData = await extractCurrentWeek();

        if (weekData.weekRange && !visitedWeeks.has(weekData.weekRange)) {
          visitedWeeks.add(weekData.weekRange);
          allCourses.push(...weekData.courses);
          console.log(`  🔎 週次 [${weekData.weekRange}] 抓取 ${weekData.courses.length} 堂`);
        }

        const nextBtn = await page.$('button.slick-next');
        if (!nextBtn) break;
        const isDisabled = await page.evaluate(el => el.classList.contains('slick-disabled') || el.disabled, nextBtn);
        if (isDisabled) break;

        try {
          await nextBtn.click({ timeout: 3000 });
          await page.waitForTimeout(1500);
        } catch (e) {
          break;
        }
      }
    } catch (err) {
      console.error(`  ⚠️ 抓取失敗：`, err.message);
    }
  }

  await browser.close();

  // 聯集去重
  const uniqueMap = new Map();
  allCourses.forEach(c => {
    const key = `${c.date}_${c.start}_${c.branch}_${c.teacher}`;
    uniqueMap.set(key, c);
  });
  
  const finalCourses = Array.from(uniqueMap.values()).sort((a, b) => 
    (a.date + a.start).localeCompare(b.date + b.start)
  );

  console.log(`\n✅ 抓取完成！共 ${finalCourses.length} 堂課。`);

  const gasUrl = process.env.GAS_WEBAPP_URL;
  if (!gasUrl) {
    console.error('❌ 未設定 GAS_WEBAPP_URL！');
    process.exit(1);
  }

  console.log('📤 寫入 Google 試算表...');
  const res = await axios.post(gasUrl, {
    secret: "WG_SECRET_TOKEN_2026",
    courses: finalCourses
  }, { timeout: 20000 });

  console.log('🎉 試算表同步結果：', res.data);
})();
