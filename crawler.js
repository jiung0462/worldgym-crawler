const { chromium } = require('playwright');
const axios = require('axios');

(async () => {
  console.log('🚀 啟動無頭瀏覽器 (抗延遲穩定版)...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.includes('google-analytics') || url.includes('facebook') || url.includes('gtag')) {
      return route.abort();
    }
    return route.continue();
  });

  const scrapeTasks = [
    {
      name: '台南 BodyCombat (全老師)',
      url: 'https://www.worldgymtaiwan.com/aerobics-schedule-search?city_code=67&class_uid=AB0060001#query_result',
      filterPOnly: false
    },
    {
      name: '台南 階梯/活力有氧 (僅限吳小P)',
      url: 'https://www.worldgymtaiwan.com/aerobics-schedule-search?city_code=67&class_uid=AB0010028,AB0010029#query_result',
      filterPOnly: true
    }
  ];

  const extractCurrentWeek = async () => {
    return await page.evaluate(() => {
      const text = document.body.innerText;
      const match = text.match(/(\d{1,2})月\s*(\d{1,2})\s*[-~至]\s*(?:(\d{1,2})月\s*)?(\d{1,2}),?\s*(\d{4})/);
      if (!match) return { courses: [], weekRange: "" };

      const startMonth = parseInt(match[1], 10);
      const startDay = parseInt(match[2], 10);
      const year = parseInt(match[5], 10);
      const weekRange = `${year}-${String(startMonth).padStart(2, '0')}-${String(startDay).padStart(2, '0')}`;
      const baseMonday = new Date(year, startMonth - 1, startDay);

      let colCenters = [];
      const dayContainers = Array.from(document.querySelectorAll('#schedule_area .schedule_list_day, #schedule_area .day_item, #schedule_area .slick-slide:not(.slick-cloned)'));
      
      if (dayContainers.length >= 7) {
        colCenters = dayContainers.slice(0, 7).map(el => {
          const r = el.getBoundingClientRect();
          return r.left + r.width / 2;
        });
      }

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

        let closestDay = 0;
        let minDiff = Infinity;
        colCenters.forEach((centerX, dayIndex) => {
          const diff = Math.abs(cardCenterX - centerX);
          if (diff < minDiff) {
            minDiff = diff;
            closestDay = dayIndex;
          }
        });

        const courseDate = new Date(baseMonday);
        courseDate.setDate(courseDate.getDate() + closestDay);
        
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

  // 翻頁輔助函式：優先使用 Slick 原生 API，並具備動畫等待保護
  const slideNav = async (direction) => {
    return await page.evaluate((dir) => {
      // 1. 嘗試呼叫 Slick API
      if (window.jQuery && jQuery('#schedule_area .slick-slider').length) {
        try {
          const slider = jQuery('#schedule_area .slick-slider');
          const currentSlide = slider.slick('slickCurrentSlide');
          slider.slick(dir === 'next' ? 'slickNext' : 'slickPrev');
          return true;
        } catch(e) {}
      }

      // 2. 備案：點擊 DOM 按鈕
      const selector = dir === 'next' ? 'button.slick-next' : 'button.slick-prev';
      const btn = document.querySelector(selector);
      if (btn && !btn.classList.contains('slick-disabled')) {
        btn.click();
        return true;
      }
      return false;
    }, direction);
  };

  const allCourses = [];

  for (let i = 0; i < scrapeTasks.length; i++) {
    const task = scrapeTasks[i];
    console.log(`\n🌐 [${i + 1}/${scrapeTasks.length}] 正在爬取任務：${task.name}`);

    try {
      await page.goto(task.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector('#schedule_area', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2500);

      // 往前回溯 2 週
      console.log('  ⏪ 正在往前回溯 2 週課表...');
      for (let prevStep = 0; prevStep < 2; prevStep++) {
        const moved = await slideNav('prev');
        if (!moved) break;
        await page.waitForTimeout(1800); // 充足等待輪播動畫
      }

      const visitedWeeks = new Set();
      let lastWeek = "";
      let noChangeCount = 0;

      // 掃描最多 8 週
      for (let week = 1; week <= 8; week++) {
        await page.waitForTimeout(1200);
        const weekData = await extractCurrentWeek();

        if (weekData.weekRange && !visitedWeeks.has(weekData.weekRange)) {
          visitedWeeks.add(weekData.weekRange);
          noChangeCount = 0;
          lastWeek = weekData.weekRange;

          let weekCourses = weekData.courses;
          if (task.filterPOnly) {
            weekCourses = weekCourses.filter(c => c.teacher && c.teacher.includes('吳小P'));
          }

          allCourses.push(...weekCourses);
          console.log(`  🔎 週次 [${weekData.weekRange}] 擷取 ${weekCourses.length} 堂課程`);
        } else if (weekData.weekRange === lastWeek) {
          noChangeCount++;
          // 連續 2 次沒變化才判定真正到底，避免單次動畫卡住就被踢出
          if (noChangeCount >= 2) {
            console.log('  📌 課表無更新或已到底。');
            break;
          }
        }

        // 翻頁至下一週
        const movedNext = await slideNav('next');
        if (!movedNext) {
          console.log('  📌 已到達官方開放的最末週。');
          break;
        }
        await page.waitForTimeout(1800); // 確保翻頁動畫徹底完成
      }
    } catch (err) {
      console.error(`  ⚠️ 任務 [${task.name}] 爬取異常：`, err.message);
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

  console.log(`\n✅ 聯集篩選完成！總計取得 ${finalCourses.length} 堂課。`);

  if (finalCourses.length === 0) {
    console.error('⚠️ 警告：抓取筆數為 0，放棄同步以保護舊資料！');
    process.exit(1);
  }

  const gasUrl = process.env.GAS_WEBAPP_URL;
  if (!gasUrl) {
    console.error('❌ 未設定 GAS_WEBAPP_URL！');
    process.exit(1);
  }

  console.log('📤 寫入 Google 試算表...');
  const res = await axios.post(gasUrl, {
    secret: "WG_SECRET_TOKEN_2026",
    courses: finalCourses
  }, { timeout: 35000 });

  console.log('🎉 試算表同步結果：', res.data);
})();
