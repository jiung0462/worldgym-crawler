const { chromium } = require('playwright');
const axios = require('axios');

(async () => {
  console.log('🚀 啟動無頭瀏覽器 (極速模式)...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  // 1. 攔截不必要的圖片、樣式與第三方追蹤代碼，大幅加速網頁載入
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.includes('google-analytics') || url.includes('facebook') || url.includes('gtag') || url.includes('doubleclick')) {
      return route.abort();
    }
    return route.continue();
  });

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

        // 提取課程名稱
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
    console.log(`\n🌐 [${u + 1}/${targetUrls.length}] 正在抓取：${currentUrl}`);

    try {
      await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForSelector('#schedule_area', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(1000);

      // 1. 往前退到最早週（最多點 3 次）
      for (let step = 0; step < 3; step++) {
        const canClickPrev = await page.evaluate(() => {
          const btn = document.querySelector('button.slick-prev');
          if (btn && !btn.classList.contains('slick-disabled') && !btn.disabled) {
            btn.click();
            return true;
          }
          return false;
        });

        if (!canClickPrev) break;
        await page.waitForTimeout(800);
      }

      // 2. 由前往後掃描抓取（最多 8 週）
      const visitedWeeks = new Set();
      let lastWeekRange = "";

      for (let week = 1; week <= 8; week++) {
        await page.waitForTimeout(800);
        const weekData = await extractCurrentWeek();

        // 檢查是否到底或重複
        if (!weekData.weekRange || weekData.weekRange === lastWeekRange) {
          console.log('  📌 課表無變化或已無資料，停止本網址掃描。');
          break;
        }

        lastWeekRange = weekData.weekRange;

        if (!visitedWeeks.has(weekData.weekRange)) {
          visitedWeeks.add(weekData.weekRange);
          allCourses.push(...weekData.courses);
          console.log(`  🔎 週次 [${weekData.weekRange}] 抓取 ${weekData.courses.length} 堂`);
        }

        // 點擊「下一週」
        const canClickNext = await page.evaluate(() => {
          const btn = document.querySelector('button.slick-next');
          if (btn && !btn.classList.contains('slick-disabled') && !btn.disabled) {
            btn.click();
            return true;
          }
          return false;
        });

        if (!canClickNext) {
          console.log('  📌 下一週按鈕已反灰，翻頁結束。');
          break;
        }
      }
    } catch (err) {
      console.error(`  ⚠️ 執行異常：`, err.message);
    }
  }

  await browser.close();

  // 去重並依日期時間排序
  const uniqueMap = new Map();
  allCourses.forEach(c => {
    const key = `${c.date}_${c.start}_${c.branch}_${c.teacher}`;
    uniqueMap.set(key, c);
  });
  
  const finalCourses = Array.from(uniqueMap.values()).sort((a, b) => 
    (a.date + a.start).localeCompare(b.date + b.start)
  );

  console.log(`\n✅ 抓取結束！共 ${finalCourses.length} 堂課。`);

  const gasUrl = process.env.GAS_WEBAPP_URL;
  if (!gasUrl) {
    console.error('❌ 未設定 GAS_WEBAPP_URL！');
    process.exit(1);
  }

  console.log('📤 寫入 Google 試算表...');
  const res = await axios.post(gasUrl, {
    secret: "WG_SECRET_TOKEN_2026",
    courses: finalCourses
  }, { timeout: 15000 });

  console.log('🎉 試算表同步結果：', res.data);
})();
