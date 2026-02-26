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
        // ── Step 1: Login ──────────────────────────────────────────────────────────
        console.log('🔐 Logging in...');
        await page.goto('https://erp.bbs.ac.in/indexLogin.php', { waitUntil: 'domcontentloaded' });
        await page.fill('#login', process.env.ERP_USERNAME);
        await page.fill('#passwd', process.env.ERP_PASSWORD);
        await page.click('#btnSubmit');
        await page.waitForLoadState('networkidle');
        console.log('✅ Login successful');

        // ── Step 2: Go directly to attendance page ─────────────────────────────────
        console.log('📋 Opening attendance page...');
        await page.goto('https://erp.bbs.ac.in/students/attendance_class_step1.php', {
            waitUntil: 'domcontentloaded'
        });

        // ── Step 3: Select current month ───────────────────────────────────────────
        const now = new Date();
        const monthValue = String(now.getMonth() + 1).padStart(2, '0');
        console.log(`📅 Selecting month: ${monthValue}`);
        await page.selectOption('#months_01', monthValue);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(2000);

        // ── Step 4: Parse subject legend (BAS-202 - Engg. Chemistry) ──────────────
        // Legend is at the bottom: "<code> - <full name>"
        const legendItems = await page.$$eval(
            '#divToPrint td, #divToPrint .printable td',
            (cells) => {
                const map = {};
                cells.forEach(cell => {
                    const text = cell.innerText.trim();
                    // Match "BAS-202 - Engg. Chemistry" pattern
                    const match = text.match(/^([A-Z]{2,}[\w-]+\d+)\s*[-–]\s*(.+)$/);
                    if (match) {
                        map[match[1].trim()] = match[2].trim();
                    }
                });
                return map;
            }
        );
        console.log('📚 Subject map:', legendItems);

        // ── Step 5: Find today's column index in thead ─────────────────────────────
        const today = now.getDate().toString();
        console.log(`🔍 Looking for date: ${today}`);

        const table = page.locator('table.table').first();
        const headers = await table.locator('thead th').all();

        let todayColIndex = -1;
        let todayHeaderText = '';

        for (let i = 0; i < headers.length; i++) {
            const text = (await headers[i].textContent()).trim();
            // Match "26\nFeb" or "26 Feb" — only the day number with word boundary
            if (new RegExp(`^\\s*${today}\\b`).test(text)) {
                todayColIndex = i;
                todayHeaderText = text.replace(/\s+/g, ' ').trim();
                break;
            }
        }

        if (todayColIndex === -1) {
            console.log(`⚠️ No column found for today (${today}). Maybe weekend or holiday.`);
            await browser.close();
            return;
        }

        console.log(`✅ Today's column: index=${todayColIndex}, header="${todayHeaderText}"`);

        // ── Step 6: Check each subject row for absence ─────────────────────────────
        // Cell values: P=Present, PP=Double Present, A=Absent, AA=Double Absent, -=No class
        const rows = await table.locator('tbody tr').all();
        const absentSubjects = [];

        for (const row of rows) {
            const cells = await row.locator('td').all();
            if (cells.length <= todayColIndex) continue;

            const subjectCode = (await cells[0].textContent()).trim();
            // Skip summary/legend rows (e.g. "G. Total", empty rows)
            if (!subjectCode || subjectCode.includes('Total') || subjectCode.includes('Legends')) continue;

            const cellText = (await cells[todayColIndex].textContent()).trim();
            console.log(`  ${subjectCode}: "${cellText}"`);

            // A or AA = absent. 'A'.includes('A')=true, 'AA'.includes('A')=true
            // P, PP, - all don't contain 'A'
            if (cellText.includes('A')) {
                const fullName = legendItems[subjectCode] || subjectCode;
                absentSubjects.push(`${subjectCode} – ${fullName}`);
            }
        }

        // ── Step 7: Screenshot ─────────────────────────────────────────────────────
        const screenshotPath = 'attendance.png';
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.log('📸 Screenshot taken');

        // ── Step 8: Notify ─────────────────────────────────────────────────────────
        const timeStr = now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

        if (absentSubjects.length === 0) {
            console.log('🎉 All present today!');
            // Uncomment to send a daily "all present" confirmation:
            // await sendTelegramMessage(`✅ All Present on ${todayHeaderText}!\n\nChecked at ${timeStr}`);
        } else {
            const message =
                `⚠️ <b>ATTENDANCE ALERT</b> 🚨

📅 <b>Date:</b> ${todayHeaderText}
🕐 <b>Checked:</b> ${timeStr}

❌ <b>Absent in ${absentSubjects.length} subject(s):</b>
${absentSubjects.map(s => `• ${s}`).join('\n')}`;

            console.log('📨 Sending Telegram alert...');
            await sendTelegramMessage(message);

            console.log('🖼 Sending screenshot...');
            await sendTelegramPhoto(screenshotPath, `Attendance – ${todayHeaderText}`);

            console.log('✅ Done! Notifications sent.');
        }

    } catch (err) {
        console.error('❌ Error:', err);
        try {
            const timeStr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
            await sendTelegramMessage(
                `🔴 <b>Bot Error!</b>\n\n${err.message}\n\n⏰ ${timeStr}\n\nCheck GitHub Actions logs.`
            );
        } catch (_) { }
        process.exit(1);
    } finally {
        await browser.close();
    }
})();

// ── Telegram Helpers ──────────────────────────────────────────────────────────

async function sendTelegramMessage(text) {
    const res = await fetch(
        `https://api.telegram.org/bot${process.env.TG_BOT_TOKEN}/sendMessage`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: process.env.TG_CHAT_ID,
                text,
                parse_mode: 'HTML'
            })
        }
    );
    if (!res.ok) throw new Error(`Telegram sendMessage: ${await res.text()}`);
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
    if (!res.ok) throw new Error(`Telegram sendPhoto: ${await res.text()}`);
}
