const { chromium } = require('playwright');
const axios = require('axios');

(async () => {
  console.log('🚀 啟動無頭瀏覽器 (往前回溯 2 週 + 往後 5 週聯集)...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  // 阻擋分析腳本加速
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.includes('google-analytics') || url.includes('facebook') || url.includes('gtag')) {
      return route.abort();
    }
    return route.continue();
  });

  const targetUrls = [
    'https://www.worldgymtaiwan.com/aerobics-schedule-search?city_code=67&class_uid=AB0060001#query_result',
    'https://www.worldgymtaiwan.com/aerobics-schedule-search?city_code=67&teacher_emp_no=6616#query_result'
  ];

  const extractCurrentWeek = async () => {
    return await page.evaluate(() => {
      // 1. 抓取當週週一基準日期
      const text = document.body.innerText;
      const match = text.match(/(\d{1,2})月\s*(\d{1,2})\s*[-~至]\s*(?:(\d{1,2})月\s*)?(\d{1,2}),?\s*(\d{4})/);
      if (!match) return { courses: [], weekRange: "" };

      const startMonth = parseInt(match[1], 10);
      const startDay = parseInt(match[2], 10);
      const year = parseInt(match[5], 10);
      const weekRange = `${year}-${String(startMonth).padStart(2, '0')}-${String(startDay).padStart(2, '0')}`;
      const baseMonday = new Date(year, startMonth - 1, startDay);

      // 2. 獲取星期欄位基準 X 座標
      let colCenters = [];
      const dayContainers = Array.from(document.querySelectorAll('#schedule_area .schedule_list_day, #schedule_area .day_item, #schedule_area .slick-slide:not(.slick-cloned)'));
      
      if (dayContainers.length >= 7) {
        colCenters = dayContainers.slice(0, 7).map(el => {
          const r = el.getBoundingClientRect();
          return r.left + r.width / 2;
        });
      }

      // 3. 抓取課程卡片
      const cards = Array.from(document.querySelectorAll('#schedule_area .class_list'));
      if (!cards.length) return { courses: [], weekRange };

      if (colCenters.length < 7) {
        const xs = cards.map(c => c.getBoundingClientRect().left);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const colW = (maxX - minX) / 6 || 1;
        colCenters = [0,1,2,3,4,5,6].map(i => minX + i * colW);
      }

      const list = [];
      cards.forEach(card => {
        const rect = card.getBoundingClientRect();
        const cardCenterX = rect.left + rect.width / 2;

        // 計算距離哪一個星期欄位中心最近 (0 = 週一, 6 = 週日)
        let closestDay = 0;
        let minDiff = Infinity;
        colCenters.forEach((centerX, dayIndex) => {
          const diff = Math.abs(cardCenterX - centerX);
          if (diff < minDiff) {
            minDiff = diff;
            closestDay = dayIndex;
          }
        });

        // 依據推算出的星期精準對齊日期
        const courseDate = new Date(baseMonday);
        courseDate.setDate(courseDate.getDate() + closestDay);
        
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

        // 課程名稱
        let className = "BODYCOMBAT®";
        const lines = card.innerText.split('\n').map(s => s.trim()).filter(Boolean);
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
      await page.waitForTimeout(2000);

      // ----------------------------------------------------
      // 關鍵步驟：往前點擊「上一週」2 次（回溯兩個禮拜）
      // ----------------------------------------------------
      console.log('  ⏪ 正在往前回溯 2 週課表...');
      for (let prevStep = 0; prevStep < 2; prevStep++) {
        const canPrev = await page.evaluate(() => {
          const btn = document.querySelector('button.slick-prev');
          if (btn && !btn.classList.contains('slick-disabled') && !btn.disabled) {
            btn.click();
            return true;
          }
          return false;
        });

        if (!canPrev) {
          console.log(`  📌 往前至第 ${prevStep} 週已無法再往前回溯。`);
          break;
        }
        await page.waitForTimeout(1200); // 等待輪播動畫滑動就定位
      }

      // ----------------------------------------------------
      // 從兩週前開始，由前往後掃描 8 週（前2週 + 本週 + 未來5週）
      // ----------------------------------------------------
      const visitedWeeks = new Set();
      let lastWeek = "";

      for (let week = 1; week <= 8; week++) {
        await page.waitForTimeout(1000);
        const weekData = await extractCurrentWeek();

        if (!weekData.weekRange || weekData.weekRange === lastWeek) {
          console.log('  📌 課表無更新或已到底。');
          break;
        }
        lastWeek = weekData.weekRange;

        if (!visitedWeeks.has(weekData.weekRange)) {
          visitedWeeks.add(weekData.weekRange);
          allCourses.push(...weekData.courses);
          console.log(`  🔎 週次 [${weekData.weekRange}] 抓取 ${weekData.courses.length} 堂課`);
        }

        // 翻頁至下一週
        const canNext = await page.evaluate(() => {
          const btn = document.querySelector('button.slick-next');
          if (btn && !btn.classList.contains('slick-disabled') && !btn.disabled) {
            btn.click();
            return true;
          }
          return false;
        });

        if (!canNext) {
          console.log('  📌 已到達官方開放的最末週。');
          break;
        }
      }
    } catch (err) {
      console.error(`  ⚠️ 爬取異常：`, err.message);
    }
  }

  await browser.close();

  // 聯集去重
  const uniqueMap = new Map();
  allCourses.forEach(c => {
    const key = `${c.date}_${c.start}_${c.branch}_${c.teacher}_${c.className}`;
    uniqueMap.set(key, c);
  });
  
  const finalCourses = Array.from(uniqueMap.values()).sort((a, b) => 
    (a.date + a.start).localeCompare(b.date + b.start)
  );

  console.log(`\n✅ 聯集完成！總計取得 ${finalCourses.length} 堂課。`);

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
