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

        // ── Step 5: Select current month ──────────────────────────────────────
        const now = new Date();
        const monthValue = String(now.getMonth() + 1).padStart(2, '0');
        console.log(`📅 Selecting month: ${monthValue}`);
        await attendanceFrame.selectOption('#months_01', monthValue);
        await attendanceFrame.waitForLoadState('networkidle');
        await attendanceFrame.waitForTimeout(2000);

        // ── Step 6: Parse legend (BAS-202 - Engg. Chemistry) ──────────────────
        // Split on ' - ' per LINE. The legend is one big <td> with all entries.
        const legendMap = await attendanceFrame.evaluate(() => {
            const map = {};
            document.querySelectorAll('td').forEach(td => {
                // Split cell content by newlines to handle multi-line legend cells
                const lines = td.innerText.trim().split('\n');
                lines.forEach(line => {
                    const text = line.trim();
                    const idx = text.indexOf(' - ');
                    if (idx > 0 && idx < 20) {
                        const code = text.substring(0, idx).trim();
                        const name = text.substring(idx + 3).trim();
                        // Validate: no spaces, has letters AND digits (subject code pattern)
                        if (code && !/\s/.test(code) && /[A-Z]/.test(code) && /\d/.test(code)) {
                            map[code] = name;
                        }
                    }
                });
            });
            return map;
        });
        console.log('📚 Legend:', JSON.stringify(legendMap));

        // ── Step 7: Find today's column ──────────────────────────────────────
        const today = now.getDate().toString();
        console.log(`🔍 Looking for date column: ${today}`);

        // Target ATTENDANCE data table (not the month-select form table)
        const attendTable = await attendanceFrame.$('table.table-striped, #divToPrint table, table.table-bordered');
        const firstRow = attendTable ? await attendTable.$('tr') : null;
        const headers = firstRow ? await firstRow.$$('th, td') : [];
        console.log(`📊 Header count: ${headers.length}`);
        if (headers.length > 0) {
            const h0 = (await headers[0].textContent()).trim().replace(/\s+/g, ' ');
            const hLast = (await headers[headers.length - 1].textContent()).trim().replace(/\s+/g, ' ');
            console.log(`  First: "${h0}" | Last: "${hLast}"`);
        }
        let todayColIndex = -1;
        let todayHeaderText = '';

        for (let i = 0; i < headers.length; i++) {
            const text = (await headers[i].textContent()).trim();
            if (new RegExp(`^\\s*${today}\\b`).test(text)) {
                todayColIndex = i;
                todayHeaderText = text.replace(/\s+/g, ' ').trim();
                break;
            }
        }

        if (todayColIndex === -1) {
            console.log(`ℹ️ No column for today (${today}) — weekend or holiday.`);
            await browser.close();
            return;
        }
        console.log(`✅ Today col index: ${todayColIndex}, header: "${todayHeaderText}"`);

        // Get data rows (skip first header row)
        const allRows = attendTable ? await attendTable.$$('tr') : [];
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
