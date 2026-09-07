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

  // 阻擋分析工具加速
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.includes('google-analytics') || url.includes('facebook') || url.includes('gtag')) {
      return route.abort();
    }
    return route.continue();
  });

  // -------------------------------------------------------------------------
  // 關鍵：請將以下網址替換為您想要「聯集」的網址清單！
  // -------------------------------------------------------------------------
  const targetUrls = [
    // 網址 1: 台南 BodyCombat
    'https://www.worldgymtaiwan.com/aerobics-schedule-search?city_code=67&class_uid=AB0060001#query_result',
    
    // 網址 2: 例如台南 BodyPump (請依照您要查詢的課程填入真實網址)
    'https://www.worldgymtaiwan.com/aerobics-schedule-search?city_code=67&teacher_emp_no=6616#query_result'
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

        // 時間
        const timeEl = card.querySelector('.newclass_time');
        let start = "", end = "";
        if (timeEl) {
          const parts = timeEl.innerText.replace(/\s+/g, '').split('|');
          start = parts[0] || "";
          end = parts[1] || "";
        }

        // 分店
        const storeEl = card.querySelector('.class_store');
        const branch = storeEl ? storeEl.innerText.replace('台南', '').replace('店', '').trim() : "";

        // 老師
        const teacherEl = card.querySelector('.teacher');
        let teacher = teacherEl ? teacherEl.innerText.trim() : "";
        if (card.innerText.includes('代課') && !teacher.includes('代課')) {
          teacher += " (代課)";
        }

        // 課程名稱（由官網卡片文字取得）
        let className = "";
        const lines = card.innerText.split('\n').map(s => s.trim()).filter(Boolean);
        // 通常第一行為時間，第二行即為課程名稱 (如 BODYCOMBAT®、BODYPUMP®)
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
    console.log(`\n🌐 [${u + 1}/${targetUrls.length}] 正在爬取：${currentUrl}`);

    try {
      await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForSelector('#schedule_area', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(1000);

      // 回溯上一週
      for (let step = 0; step < 3; step++) {
        const canPrev = await page.evaluate(() => {
          const btn = document.querySelector('button.slick-prev');
          if (btn && !btn.classList.contains('slick-disabled') && !btn.disabled) {
            btn.click();
            return true;
          }
          return false;
        });
        if (!canPrev) break;
        await page.waitForTimeout(800);
      }

      // 由前往後翻頁掃描
      const visitedWeeks = new Set();
      let lastWeek = "";
      for (let week = 1; week <= 8; week++) {
        await page.waitForTimeout(800);
        const weekData = await extractCurrentWeek();

        if (!weekData.weekRange || weekData.weekRange === lastWeek) break;
        lastWeek = weekData.weekRange;

        if (!visitedWeeks.has(weekData.weekRange)) {
          visitedWeeks.add(weekData.weekRange);
          allCourses.push(...weekData.courses);
          console.log(`  🔎 週次 [${weekData.weekRange}] 抓取 ${weekData.courses.length} 筆課程`);
        }

        const canNext = await page.evaluate(() => {
          const btn = document.querySelector('button.slick-next');
          if (btn && !btn.classList.contains('slick-disabled') && !btn.disabled) {
            btn.click();
            return true;
          }
          return false;
        });
        if (!canNext) break;
      }
    } catch (err) {
      console.error(`  ⚠️ 網址抓取失敗：`, err.message);
    }
  }

  await browser.close();

  // 聯集去重：以 日期 + 時間 + 分店 + 老師 + 課程名稱 做唯一辨識
  const uniqueMap = new Map();
  allCourses.forEach(c => {
    const key = `${c.date}_${c.start}_${c.branch}_${c.teacher}_${c.className}`;
    uniqueMap.set(key, c);
  });
  
  const finalCourses = Array.from(uniqueMap.values()).sort((a, b) => 
    (a.date + a.start).localeCompare(b.date + b.start)
  );

  console.log(`\n✅ 聯集抓取結束！總共取得 ${finalCourses.length} 堂課。`);

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
