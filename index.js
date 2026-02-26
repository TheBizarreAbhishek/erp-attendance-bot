const { chromium } = require('playwright');
const fetch = require('node-fetch');
const fs = require('fs');
const FormData = require('form-data');

(async () => {
    console.log('🚀 ERP Attendance Bot started...');

    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        // ── Step 1: Login ──────────────────────────────────────────────────────
        console.log('🔐 Logging in...');
        await page.goto('https://erp.bbs.ac.in/indexLogin.php', { waitUntil: 'domcontentloaded' });
        await page.fill('#login', process.env.ERP_USERNAME);
        await page.fill('#passwd', process.env.ERP_PASSWORD);
        await page.click('#btnSubmit');

        // Wait until we land on index.php (confirms login success)
        await page.waitForURL('**/students/index.php', { timeout: 20000 });
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(2000); // let all frames settle
        console.log('✅ Login successful - on dashboard');

        // ── Step 2: Debug all frames loaded ───────────────────────────────────
        const allFrameUrls = page.frames().map(f => f.url());
        console.log('📌 Frames loaded:', allFrameUrls.join(' | '));

        // ── Step 3: Click "Attendance (%age)" in the left nav frame ───────────
        let clickedAttendance = false;
        for (const frame of page.frames()) {
            try {
                // Try text-based click
                const link = frame.locator('a').filter({ hasText: /Attendance.*%age/i });
                if (await link.count() > 0) {
                    await link.first().click();
                    clickedAttendance = true;
                    console.log('📋 Clicked Attendance (%age) link in frame:', frame.url());
                    break;
                }
            } catch (_) { }
        }

        if (!clickedAttendance) {
            // Fallback: try original tree link IDs
            for (const frame of page.frames()) {
                try {
                    if (await frame.locator('#tree-5-link').count() > 0) {
                        await frame.click('#tree-5-link');
                        await page.waitForTimeout(1000);
                    }
                    if (await frame.locator('#tree-10-link').count() > 0) {
                        await frame.click('#tree-10-link');
                        clickedAttendance = true;
                        console.log('📋 Clicked via tree link IDs');
                        break;
                    }
                } catch (_) { }
            }
        }

        // Wait for the attendance frame to load
        await page.waitForTimeout(3000);

        // ── Step 4: Find the attendance content frame ──────────────────────────
        let attendanceFrame = null;
        for (const frame of page.frames()) {
            if (frame.url().includes('attendance_class_step1')) {
                attendanceFrame = frame;
                console.log('✅ Found attendance frame:', frame.url());
                break;
            }
        }

        if (!attendanceFrame) {
            const urls = page.frames().map(f => f.url()).join(', ');
            throw new Error(`Attendance frame not found. Available frames: ${urls}`);
        }

        // ── Step 5: Select month and WAIT for frame to reload ─────────────────
        // The dropdown has onchange="this.form.submit()" — need to wait for navigation
        const now = new Date();
        const monthValue = String(now.getMonth() + 1).padStart(2, '0');
        console.log(`📅 Selecting month: ${monthValue}`);
        await Promise.all([
            attendanceFrame.waitForNavigation({ waitUntil: 'networkidle' }),
            attendanceFrame.selectOption('#months_01', monthValue)
        ]);

        console.log('⏳ Month selected - waiting for content frame to update...');
        await page.waitForTimeout(3000);

        // The attendance table loads inside index1.php (content frame), not step1 form frame
        const frameUrls2 = page.frames().map(f => f.url());
        console.log('📌 Frames after select:', frameUrls2.join(' | '));

        const tableFrame = page.frames().find(f => f.url().includes('index1.php'));

        if (!tableFrame) {
            throw new Error(`index1.php frame not found. Frames: ${frameUrls2.join(', ')}`);
        }
        console.log('✅ Table frame:', tableFrame.url());


        // ── Step 7: Parse legend from TABLE frame ─────────────────────────────
        // Split on ' - ' per LINE. The legend is one big <td> with all entries.
        const legendMap = await tableFrame.evaluate(() => {
            const map = {};
            document.querySelectorAll('td').forEach(td => {
                const lines = td.innerText.trim().split('\n');
                lines.forEach(line => {
                    const text = line.trim();
                    const idx = text.indexOf(' - ');
                    if (idx > 0 && idx < 20) {
                        const code = text.substring(0, idx).trim();
                        const name = text.substring(idx + 3).trim();
                        if (code && !/\s/.test(code) && /[A-Z]/.test(code) && /\d/.test(code)) {
                            map[code] = name;
                        }
                    }
                });
            });
            return map;
        });
        console.log('📚 Legend:', JSON.stringify(legendMap));

        // ── Step 8: Find today's column in table frame headers ────────────────
        const today = now.getDate().toString();
        console.log(`🔍 Looking for date column: ${today}`);

        // Get ALL cells in first row (th AND td) so column indices match data rows
        const firstHeaderRow = await tableFrame.$('tr');
        const headers = firstHeaderRow ? await firstHeaderRow.$$('th, td') : [];
        console.log(`📊 Header count: ${headers.length}`);

        // Log ALL headers for debugging
        const allHeaderTexts = [];
        for (const h of headers) {
            allHeaderTexts.push((await h.textContent()).trim().replace(/\s+/g, ' '));
        }
        console.log('📋 Headers:', JSON.stringify(allHeaderTexts));

        let todayColIndex = -1;
        let todayHeaderText = '';
        const todayNum = parseInt(today);

        for (let i = 0; i < headers.length; i++) {
            const text = allHeaderTexts[i];
            // Extract first number from header (handles "26 Feb", "26\nFri", "26-02" etc.)
            const numMatch = text.match(/\d+/);
            if (numMatch && parseInt(numMatch[0]) === todayNum) {
                todayColIndex = i;
                todayHeaderText = text;
                console.log(`🎯 Found today column at index: ${i} → "${text}"`);
                break;
            }
        }

        if (todayColIndex === -1) {
            console.log(`ℹ️ No column for today (${today}) — weekend or holiday.`);
            await browser.close();
            return;
        }

        // Get data rows from table frame (skip first header row)
        const allRows = await tableFrame.$$('tr');
        const dataRows = allRows.slice(1);
        const absentSubjects = [];

        for (const row of dataRows) {
            const cells = await row.$$('td');
            if (cells.length <= todayColIndex) continue;

            const code = (await cells[0].textContent()).trim();
            if (!code || code.includes('Total') || code.includes('Legend') || code.includes('G.')) continue;

            const cellText = (await cells[todayColIndex].textContent()).trim();
            console.log(`  ${code}: "${cellText}"`);

            if (cellText.includes('A')) { // catches 'A' and 'AA'
                const fullName = legendMap[code] || code;
                absentSubjects.push(`${code} – ${fullName}`);
            }
        }

        // ── Step 9: Screenshot ─────────────────────────────────────────────────
        const screenshotPath = 'attendance.png';
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.log('📸 Screenshot saved');

        // ── Step 10: Notify ────────────────────────────────────────────────────
        const timeStr = now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

        if (absentSubjects.length === 0) {
            console.log('🎉 All present today!');
            // Always notify so user can confirm bot is working
            await sendTelegramMessage(`✅ <b>All Present!</b>\n\n📅 <b>Date:</b> ${todayHeaderText}\n🕐 <b>Checked:</b> ${timeStr}\n\nKoi bhi subject mein absent nahi ho 🎉`);
        } else {
            const message =
                `⚠️ <b>ATTENDANCE ALERT</b> 🚨

📅 <b>Date:</b> ${todayHeaderText}
🕐 <b>Checked:</b> ${timeStr}

❌ <b>Absent in ${absentSubjects.length} subject(s):</b>
${absentSubjects.map(s => `• ${s}`).join('\n')}`;

            console.log('📨 Sending Telegram alert...');
            await sendTelegramMessage(message);
            await sendTelegramPhoto(screenshotPath, `Attendance – ${todayHeaderText}`);
            console.log('✅ Notification sent!');
        }

    } catch (err) {
        console.error('❌ Error:', err.message);
        try {
            const timeStr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
            await sendTelegramMessage(`🔴 <b>Bot Error!</b>\n\n<code>${err.message}</code>\n\n⏰ ${timeStr}`);
        } catch (_) { }
        process.exit(1);
    } finally {
        await browser.close();
    }
})();

// ── Telegram Helpers ────────────────────────────────────────────────────────

async function sendTelegramMessage(text) {
    const res = await fetch(
        `https://api.telegram.org/bot${process.env.TG_BOT_TOKEN}/sendMessage`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: process.env.TG_CHAT_ID, text, parse_mode: 'HTML' })
        }
    );
    if (!res.ok) throw new Error(`sendMessage failed: ${await res.text()}`);
}

async function sendTelegramPhoto(photoPath, caption = '') {
    const form = new FormData();
    form.append('chat_id', process.env.TG_CHAT_ID);
    form.append('photo', fs.createReadStream(photoPath));
    form.append('caption', caption);
    const res = await fetch(
        `https://api.telegram.org/bot${process.env.TG_BOT_TOKEN}/sendPhoto`,
        { method: 'POST', body: form }
    );
    if (!res.ok) throw new Error(`sendPhoto failed: ${await res.text()}`);
}
