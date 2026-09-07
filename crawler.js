const { chromium } = require('playwright');
const axios = require('axios');

(async () => {
  console.log('🚀 啟動無頭瀏覽器 (穩固容錯版)...');
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

  const targetUrls = [
    'https://www.worldgymtaiwan.com/aerobics-schedule-search?city_code=67&class_uid=AB0060001#query_result',
    'https://www.worldgymtaiwan.com/aerobics-schedule-search?city_code=67&teacher_emp_no=6616#query_result'
  ];

  const extractCurrentWeek = async () => {
    return await page.evaluate(() => {
      try {
        const text = document.body.innerText;
        const match = text.match(/(\d{1,2})月\s*(\d{1,2})\s*[-~至]\s*(?:(\d{1,2})月\s*)?(\d{1,2}),?\s*(\d{4})/);
        if (!match) return { courses: [], weekRange: "" };

        const startMonth = parseInt(match[1], 10);
        const startDay = parseInt(match[2], 10);
        const year = parseInt(match[5], 10);
        const weekRange = `${year}-${String(startMonth).padStart(2, '0')}-${String(startDay).padStart(2, '0')}`;
        const baseMonday = new Date(year, startMonth - 1, startDay);

        let colCenters = [];
        const dayContainers = Array.from(document.querySelectorAll('#schedule_area .schedule_list_day, #schedule_area .day_item, #schedule_area .slick-slide'))
          .filter(el => !el.classList.contains('slick-cloned'));
        
        if (dayContainers.length >= 7) {
          colCenters = dayContainers.slice(0, 7).map(el => {
            const r = el.getBoundingClientRect();
            return r.left + r.width / 2;
          });
        }

        const allRawCards = Array.from(document.querySelectorAll('#schedule_area .class_list'));
        const cards = allRawCards.filter(card => {
          if (card.closest && card.closest('.slick-cloned')) return false;
          const rect = card.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });

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
      } catch (e) {
        return { courses: [], weekRange: "", err: e.toString() };
      }
    });
  };

  const allCourses = [];

  for (let u = 0; u < targetUrls.length; u++) {
    const currentUrl = targetUrls[u];
    console.log(`\n🌐 [${u + 1}/${targetUrls.length}] 正在爬取：${currentUrl}`);

    try {
      await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector('#schedule_area', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);

      console.log('  ⏪ 往前回溯 2 週課表...');
      for (let prevStep = 0; prevStep < 2; prevStep++) {
        const canPrev = await page.evaluate(() => {
          const btn = document.querySelector('button.slick-prev');
          if (btn && !btn.classList.contains('slick-disabled') && !btn.disabled) {
            btn.click();
            return true;
          }
          return false;
        });

        if (!canPrev) break;
        await page.waitForTimeout(1200);
      }

      const visitedWeeks = new Set();
      let lastWeek = "";

      for (let week = 1; week <= 8; week++) {
        await page.waitForTimeout(1200);
        const weekData = await extractCurrentWeek();

        if (weekData.err) {
          console.log('  ⚠️ 頁面解析警告：', weekData.err);
        }

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
      console.error(`  ⚠️ 網址抓取過程發生非致命異常：`, err.message);
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

  console.log(`\n✅ 爬取結束！總計取得 ${finalCourses.length} 堂課。`);

  const gasUrl = process.env.GAS_WEBAPP_URL;
  if (!gasUrl) {
    console.error('❌ 未設定 GAS_WEBAPP_URL 環境變數！');
    process.exit(1);
  }

  console.log('📤 寫入 Google 試算表 (逾時延長至 60 秒)...');
  try {
    const res = await axios.post(gasUrl, {
      secret: "WG_SECRET_TOKEN_2026",
      courses: finalCourses
    }, { 
      timeout: 60000, // 延長至 60 秒
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
    console.log('🎉 試算表同步結果：', res.data);
  } catch (postErr) {
    console.error('❌ POST 至 Google Apps Script 失敗：', postErr.response ? postErr.response.data : postErr.message);
    process.exit(1);
  }
})();
