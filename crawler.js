const { chromium } = require('playwright');
const axios = require('axios');

(async () => {
  console.log('🚀 啟動無頭瀏覽器...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.setViewportSize({ width: 1440, height: 900 });

  // 進入台南 BodyCombat 查詢頁
  const targetUrl = 'https://www.worldgymtaiwan.com/aerobics-schedule-search?city_code=67&class_uid=AB0060001#query_result';
  await page.goto(targetUrl, { waitUntil: 'networkidle' });

  // 抽取單週課表的共用函式
  const extractCurrentWeek = async () => {
    return await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('#schedule_area .class_list'));
      if (!cards.length) return { courses: [], weekRange: "" };

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
  };

  // 等待課表區域載入
  await page.waitForSelector('#schedule_area', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1500);

  // ----------------------------------------------------
  // 步驟一：一路往前點「Previous」，退到官網最早保留的週次
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

    console.log('👈 點擊前往上一週...');
    await prevBtn.click();
    await page.waitForTimeout(1500);
  }

  // ----------------------------------------------------
  // 步驟二：由最早週開始，一路往後點「Next」抓到最後一週
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

    console.log('👉 點擊前往下一週...');
    await nextBtn.click();
    await page.waitForTimeout(1500);
  }

  await browser.close();

  // 去重並按日期與時間嚴格排序
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
  });

  console.log('🎉 試算表同步結果：', res.data);
})();
