const { chromium } = require('playwright');
const axios = require('axios');

(async () => {
  console.log('🚀 啟動無頭瀏覽器...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // 進入台南 BodyCombat 查詢頁
  const targetUrl = 'https://www.worldgymtaiwan.com/aerobics-schedule-search?city_code=67&class_uid=AB0060001#query_result';
  await page.goto(targetUrl, { waitUntil: 'networkidle' });

  const allCourses = [];
  let previousWeekStr = "";

  // 連續抓取當前週以及往後的開放週數 (最多往後抓 5 週)
  for (let week = 1; week <= 5; week++) {
    console.log(`🔎 正在抓取第 ${week} 週資料...`);
    await page.waitForTimeout(2000);

    const weekData = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('#schedule_area .class_list'));
      if (!cards.length) return { courses: [], weekRange: "" };

      // 檢查日期標題 (如: 9月 7-13, 2026)
      const headerMatch = document.body.innerText.match(/(\d{1,2})月\s*(\d{1,2})-(\d{1,2}),?\s*(\d{4})/);
      let baseMonday;
      let weekRange = "";
      if (headerMatch) {
        const [_, m, startDay, endDay, y] = headerMatch;
        weekRange = `${y}-${m}-${startDay}`;
        baseMonday = new Date(parseInt(y), parseInt(m) - 1, parseInt(startDay));
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

    if (weekData.weekRange === previousWeekStr || weekData.courses.length === 0) {
      console.log('📌 已到達官網最後開放週數，停止翻頁。');
      break;
    }

    allCourses.push(...weekData.courses);
    previousWeekStr = weekData.weekRange;

    // 嘗試點擊「下週 (Next)」按鈕
    const nextBtn = await page.$('.next, a:has-text("Next"), [title*="下週"]');
    if (nextBtn) {
      await nextBtn.click();
      await page.waitForTimeout(1500);
    } else {
      break;
    }
  }

  await browser.close();

  // 移除重複並按時間排序
  const uniqueMap = new Map();
  allCourses.forEach(c => uniqueMap.set(`${c.date}_${c.start}_${c.branch}`, c));
  const finalCourses = Array.from(uniqueMap.values()).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));

  console.log(`✅ 抓取結束，共獲取 ${finalCourses.length} 堂真實課程！`);

  // 將資料推送到 Google 試算表
  const gasUrl = process.env.GAS_WEBAPP_URL;
  if (!gasUrl) {
    console.error('❌ 未設定 GAS_WEBAPP_URL 環境變數！');
    process.exit(1);
  }

  console.log('📤 正在寫入 Google 試算表...');
  const res = await axios.post(gasUrl, {
    secret: "WG_SECRET_TOKEN_2026",
    courses: finalCourses
  });

  console.log('🎉 試算表同步結果：', res.data);
})();
