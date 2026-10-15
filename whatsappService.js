import fs from 'node:fs/promises';
import path from 'path';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer';
import 'dotenv/config';

const SESSION_DIR = path.resolve(
    process.env.WHATSAPP_SESSION_DIR || './whatsapp_session'
);

const CHROME_PATH =
    process.env.WHATSAPP_CHROME_PATH ||
    'C:/Program Files/Google/Chrome/Application/chrome.exe';

const WHATSAPP_URL =
    process.env.WHATSAPP_WEB_URL ||
    'https://web.whatsapp.com';

const MAX_SEND_ATTEMPTS = Number(
    process.env.WHATSAPP_MAX_SEND_ATTEMPTS || 3
);

const RETRY_MS = Number(
    process.env.WHATSAPP_RETRY_MS || 3000
);

const ACTION_TIMEOUT = Number(
    process.env.WHATSAPP_ACTION_TIMEOUT || 30000
);

let browser = null;
let page = null;
let initialized = false;
let initializing = null;

// تمام عملیات واتساپ باید روی یک Page و به‌صورت ترتیبی انجام شوند.
let actionQueue = Promise.resolve();

// شماره‌هایی که در همین اجرای سرویس به‌طور قطعی فاقد حساب واتساپ تشخیص داده شده‌اند.
// برای ماندگاری پس از ری‌استارت، Worker/مدل کمپین نیز باید reason را در دیتابیس ثبت کند.
const whatsappUnavailablePhones = new Set();
const UNAVAILABLE_PHONES_FILE = path.resolve(
    process.env.WHATSAPP_UNAVAILABLE_PHONES_FILE || './whatsapp-unavailable-phones.json'
);
let unavailablePhonesLoaded = false;
let unavailablePhonesLoading = null;

async function loadUnavailablePhones() {
    if (unavailablePhonesLoaded) return;
    if (unavailablePhonesLoading) return unavailablePhonesLoading;

    unavailablePhonesLoading = (async () => {
        try {
            const raw = await fs.readFile(UNAVAILABLE_PHONES_FILE, 'utf8');
            const parsed = JSON.parse(raw);
            const phones = Array.isArray(parsed) ? parsed : parsed.phones;
            if (Array.isArray(phones)) {
                for (const value of phones) {
                    const normalized = normalizePhoneForUrlOrLog(value);
                    if (normalized) whatsappUnavailablePhones.add(normalized);
                }
            }
        } catch (error) {
            if (error?.code !== 'ENOENT') {
                console.warn('[WhatsAppService] خواندن فهرست شماره‌های فاقد واتساپ ناموفق بود:', error.message);
            }
        } finally {
            unavailablePhonesLoaded = true;
            unavailablePhonesLoading = null;
        }
    })();

    return unavailablePhonesLoading;
}

async function markWhatsAppUnavailable(mobile) {
    const phone = normalizePhoneForUrlOrLog(mobile);
    if (!phone) return;
    await loadUnavailablePhones();
    whatsappUnavailablePhones.add(phone);
    try {
        await fs.writeFile(
            UNAVAILABLE_PHONES_FILE,
            JSON.stringify({
                updatedAt: new Date().toISOString(),
                phones: [...whatsappUnavailablePhones]
            }, null, 2),
            'utf8'
        );
    } catch (error) {
        console.warn('[WhatsAppService] ذخیره فهرست شماره‌های فاقد واتساپ ناموفق بود:', error.message);
    }
}

function normalizePhone(value) {
    return String(value || '')
        .trim()
        .replace(/[\s\-().]/g, '')
        .replace(/^00/, '+');
}

function normalizePhoneForUrlOrLog(value) {
    const phone = normalizePhone(value);
    return phone.startsWith('+') ? phone.slice(1) : phone;
}

// شماره مخصوص فیلد Phone در فرم مخاطب واتساپ: کد ایران و صفر ابتدایی حذف می‌شود.
// نمونه‌ها: +989175302097، 989175302097، 00989175302097، 09175302097
// همگی به 9175302097 تبدیل می‌شوند. مقدار اصلی برای جستجو و لینک‌ها تغییر نمی‌کند.
function normalizePhoneForContactField(value) {
    let digits = String(value ?? '')
        .replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
        .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
        .replace(/\D/g, '');

    if (digits.startsWith('0098')) digits = digits.slice(4);
    else if (digits.startsWith('98')) digits = digits.slice(2);

    if (digits.startsWith('0')) digits = digits.slice(1);
    return digits;
}

async function pasteWholeMessage(activePage, element, value) {
    const message = String(value ?? '');
    if (!message) throw new Error('متن پیام خالی است.');

    await element.click();

    // روش اصلی: قرار دادن کل متن در Clipboard و Paste کردن آن مثل کاربر.
    try {
        const origin = new URL(WHATSAPP_URL).origin;
        await activePage.browserContext().overridePermissions(origin, [
            'clipboard-read',
            'clipboard-write'
        ]);
        const copied = await activePage.evaluate(async text => {
            if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
                return false;
            }
            await navigator.clipboard.writeText(text);
            return true;
        }, message);

        if (copied) {
            await activePage.keyboard.down('Control');
            await activePage.keyboard.press('V');
            await activePage.keyboard.up('Control');
            await wait(500);

            const pasted = await element.evaluate(el =>
                String(el.innerText || el.textContent || '').replace(/\u00a0/g, ' ').trim()
            ).catch(() => '');
            const expectedStart = message.trim().slice(0, Math.min(24, message.trim().length));
            if (pasted && pasted.includes(expectedStart)) return 'clipboard-paste';
        }
    } catch (error) {
        console.warn('[WhatsAppService] Clipboard paste در دسترس نبود؛ درج یک‌جای متن امتحان می‌شود:', error.message);
    }

    // پشتیبان: متن را با یک عملیات درج می‌کنیم، نه تایپ حرف‌به‌حرف؛ بنابراین Enterهای داخل متن
    // پیام جداگانه ارسال نمی‌کنند و متن کامل پیش از ارسال در کادر قرار می‌گیرد.
    await element.click();
    await activePage.keyboard.down('Control');
    await activePage.keyboard.press('A');
    await activePage.keyboard.up('Control');

    // Puppeteer در بعضی نسخه‌ها keyboard.insertText ندارد. از CDP Input.insertText
    // استفاده می‌کنیم تا کل متن در یک عملیات وارد شود و newlineها کلید Enter تلقی نشوند.
    let cdpSession = null;
    try {
        cdpSession = await activePage.createCDPSession();
        await cdpSession.send('Input.insertText', { text: message });
    } catch (insertError) {
        throw new Error(`درج یک‌جای متن با CDP ناموفق بود: ${insertError.message}`);
    } finally {
        if (cdpSession) await cdpSession.detach().catch(() => { });
    }
    await wait(500);

    const inserted = await element.evaluate(el =>
        String(el.innerText || el.textContent || '').replace(/\u00a0/g, ' ').trim()
    ).catch(() => '');
    const expectedStart = message.trim().slice(0, Math.min(24, message.trim().length));
    if (!inserted || !inserted.includes(expectedStart)) {
        throw new Error('متن کامل در کادر پیام تأیید نشد؛ برای جلوگیری از ارسال ناقص، ارسال انجام نشد.');
    }
    return 'cdp-insertText';
}

async function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getActivePage() {
    if (page && !page.isClosed()) return page;

    if (!browser) return null;

    const pages = await browser.pages();
    page = pages.find(p => !p.isClosed()) || null;
    return page;
}

export async function initWhatsAppService() {
    if (initialized && browser && page && !page.isClosed()) {
        return page;
    }

    if (initializing) return initializing;

    initializing = (async () => {
        await fs.mkdir(SESSION_DIR, { recursive: true });

        const launchOptions = {
            headless: false,
            userDataDir: SESSION_DIR,
            defaultViewport: {
                width: 1280,
                height: 800
            },
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled'
            ]
        };

        if (existsSync(CHROME_PATH)) {
            launchOptions.executablePath = CHROME_PATH;
        }

        browser = await puppeteer.launch(launchOptions);

        const pages = await browser.pages();
        page = pages[0] || await browser.newPage();

        await page.setViewport({
            width: 1280,
            height: 800
        });

        await page.goto(WHATSAPP_URL, {
            waitUntil: 'domcontentloaded',
            timeout: ACTION_TIMEOUT
        }).catch(error => {
            console.warn(
                '[WhatsAppService] باز کردن WhatsApp Web ناموفق بود:',
                error.message
            );
        });

        initialized = true;

        console.log(
            `[WhatsAppService] سرویس واتساپ آماده شد | ${WHATSAPP_URL}`
        );

        return page;
    })();

    try {
        return await initializing;
    } finally {
        initializing = null;
    }
}

export async function getWhatsAppAuthStatus() {
    return {
        success: true,
        initialized,
        connected: Boolean(page && !page.isClosed()),
        url: WHATSAPP_URL
    };
}

export async function sendCode() {
    return {
        success: false,
        error: 'WhatsApp Web از ورود با کد در این سرویس استفاده نمی‌کند؛ ورود با QR انجام می‌شود.'
    };
}

export async function verifyCode() {
    return {
        success: false,
        error: 'احراز هویت WhatsApp Web در مرحله خزش با QR انجام می‌شود.'
    };
}

export async function logoutWhatsApp() {
    try {
        if (browser) {
            await browser.close().catch(() => { });
        }
    } finally {
        browser = null;
        page = null;
        initialized = false;
    }

    return { success: true };
}

export async function resolveWhatsAppTarget(mobile) {
    const phone = normalizePhoneForUrlOrLog(mobile);

    if (!phone) {
        throw new Error('شماره موبایل برای واتساپ وارد نشده است.');
    }

    return {
        success: true,
        phone,
        url: `https://api.whatsapp.com/send?phone=${encodeURIComponent(phone)}`
    };
}

export async function createWhatsAppContact(name, mobile) {
    const phone = normalizePhone(mobile);
    if (!phone) {
        throw new Error('شماره موبایل برای تست مخاطب وارد نشده است.');
    }

    const activePage = await getActivePage() || await initWhatsAppService();
    if (!activePage || activePage.isClosed()) {
        throw new Error('صفحه واتساپ در دسترس نیست.');
    }

    // مرحله تست: فقط فرم مخاطب را باز می‌کنیم و دو فیلد را پر می‌کنیم؛ ذخیره نمی‌کنیم.
    console.log(`[WhatsAppService] 🧪 شروع تست افزودن مخاطب | شماره: ${phone}`);
    await activePage.bringToFront();

    await activePage.keyboard.down('Control');
    await activePage.keyboard.down('Alt');
    await activePage.keyboard.press('n');
    await activePage.keyboard.up('Alt');
    await activePage.keyboard.up('Control');
    await wait(1000);

    const newContactClicked = await activePage.evaluate(() => {
        const visible = el => {
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 &&
                style.visibility !== 'hidden' && style.display !== 'none';
        };
        const candidates = Array.from(document.querySelectorAll('button,[role="button"],[tabindex],div,span'))
            .filter(el => visible(el) && (el.innerText || el.textContent || '').trim() === 'New contact')
            .sort((a, b) => {
                const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
                return (ar.width * ar.height) - (br.width * br.height);
            });
        const target = candidates[0];
        if (!target) return false;
        (target.closest('button,[role="button"]') || target).click();
        return true;
    });

    if (!newContactClicked) {
        throw new Error('دکمه New contact پیدا نشد؛ صفحه فعلی واتساپ را بررسی کن.');
    }
    await wait(800);

    async function findVisibleInput(candidates, description) {
        const handle = await activePage.waitForFunction((items) => {
            const visible = el => {
                const rect = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 &&
                    style.visibility !== 'hidden' && style.display !== 'none';
            };
            const inputs = Array.from(document.querySelectorAll('input,textarea,[contenteditable="true"]'));
            for (const item of items) {
                const target = inputs.find(el => {
                    const attrText = [
                        el.getAttribute('placeholder'), el.getAttribute('aria-label'),
                        el.getAttribute('name'), el.getAttribute('data-testid'), el.getAttribute('title')
                    ].filter(Boolean).join(' ').toLowerCase();
                    return visible(el) && attrText.includes(item.toLowerCase());
                });
                if (target) return target;
            }
            for (const item of items) {
                const labels = Array.from(document.querySelectorAll('label'))
                    .filter(el => visible(el) && (el.innerText || '').toLowerCase().includes(item.toLowerCase()));
                for (const label of labels) {
                    const target = label.control ||
                        label.querySelector('input,textarea,[contenteditable="true"]') ||
                        label.parentElement?.querySelector('input,textarea,[contenteditable="true"]');
                    if (target && visible(target)) return target;
                }
            }
            return false;
        }, { timeout: ACTION_TIMEOUT }, candidates);
        const element = handle.asElement();
        if (!element) throw new Error(`فیلد ${description} پیدا نشد.`);
        return element;
    }

    async function fillField(element, value) {
        await element.click();
        await activePage.keyboard.down('Control');
        await activePage.keyboard.press('a');
        await activePage.keyboard.up('Control');
        await element.type(value, { delay: 35 });
    }

    const firstNameInput = await findVisibleInput(['first name', 'firstname', 'given-name'], 'First name');
    await fillField(firstNameInput, phone);

    const phoneInput = await findVisibleInput(['phone', 'tel', 'mobile'], 'Phone');
    await fillField(phoneInput, phone);

    console.log(`[WhatsAppService] ✅ فرم مخاطب فقط پر شد؛ هنوز ذخیره نشده است | شماره: ${phone}`);
    return {
        success: true,
        stage: 'contact_fields_filled',
        saved: false,
        name: phone,
        phone,
        message: 'فرم New contact باز شد و فیلدهای First name و Phone پر شدند؛ برای تست، ذخیره انجام نشد.'
    };
}

/**
 * ارسال پیام متنی واتساپ با URL مستقیم.
 *
 * جریان کار:
 * 1) شماره را نرمال می‌کنیم.
 * 2) لینک web.whatsapp.com/send را می‌سازیم تا اپ دسکتاپ باز نشود.
 * 3) لینک را روی همان Page لاگین‌شده WhatsApp Web باز می‌کنیم.
 * 5) متن به‌صورت prefilled داخل composer قرار می‌گیرد.
 * 6) با Enter ارسال نهایی انجام می‌شود.
 */
const NO_WHATSAPP_MESSAGE =
    'This phone number is not on WhatsApp. Invite them on your primary device.';

function isVisibleInPage(el) {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 &&
        style.display !== 'none' && style.visibility !== 'hidden' &&
        style.opacity !== '0';
}

async function clickWhatsAppText(activePage, phrases, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const clicked = await activePage.evaluate((phrases) => {
            const norm = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
            const visible = el => {
                const rect = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 &&
                    style.display !== 'none' && style.visibility !== 'hidden' &&
                    style.opacity !== '0';
            };
            const wanted = phrases.map(norm);
            const elements = [...document.querySelectorAll(
                'button,[role="button"],[role="menuitem"],a,div,span,[title],[aria-label]'
            )];
            const candidates = elements.filter(el => {
                if (!visible(el)) return false;
                const texts = [
                    el.innerText, el.getAttribute('aria-label'),
                    el.getAttribute('title'), el.getAttribute('data-testid')
                ].map(norm);
                return wanted.some(w => w && texts.some(t =>
                    t === w || (t.length < 100 && t.includes(w))
                ));
            });
            candidates.sort((a, b) => {
                const at = (a.innerText || a.getAttribute('aria-label') || a.getAttribute('title') || '').length;
                const bt = (b.innerText || b.getAttribute('aria-label') || b.getAttribute('title') || '').length;
                const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
                return at - bt || (ar.width * ar.height) - (br.width * br.height);
            });
            const target = candidates[0];
            if (!target) return false;
            (target.closest('button,[role="button"],[role="menuitem"],a') || target).click();
            return true;
        }, phrases).catch(() => false);
        if (clicked) return true;
        await wait(250);
    }
    return false;
}

async function clickWhatsAppSelectors(activePage, selectors, timeout = 7000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        for (const selector of selectors) {
            const elements = await activePage.$$(selector).catch(() => []);
            for (const element of elements) {
                const visible = await element.evaluate(isVisibleInPage).catch(() => false);
                if (!visible) continue;
                try {
                    await element.click({ timeout: 1500 });
                } catch {
                    await element.evaluate(el => el.click()).catch(() => { });
                }
                return selector;
            }
        }
        await wait(250);
    }
    return null;
}

async function fillWhatsAppField(activePage, labels, value, timeout = 12000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const filled = await activePage.evaluate(({ labels, value }) => {
            const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
            const visible = el => {
                const rect = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 &&
                    style.display !== 'none' && style.visibility !== 'hidden';
            };
            const wanted = labels.map(norm);
            const fields = [...document.querySelectorAll(
                'input:not([type="checkbox"]),textarea,[contenteditable="true"]'
            )];
            const field = fields.find(el => {
                if (!visible(el)) return false;
                const attrs = [
                    el.getAttribute('placeholder'), el.getAttribute('aria-label'),
                    el.getAttribute('name'), el.getAttribute('title'),
                    el.getAttribute('data-testid')
                ].map(norm);
                const labelText = norm(el.labels ? [...el.labels].map(x => x.innerText).join(' ') : '');
                return wanted.some(w =>
                    attrs.some(a => a === w || (a && a.includes(w))) ||
                    (labelText && labelText.includes(w))
                );
            });
            if (!field) return false;
            field.focus();
            if (field.isContentEditable) {
                field.textContent = value;
                field.dispatchEvent(new InputEvent('input', {
                    bubbles: true, inputType: 'insertText', data: value
                }));
            } else {
                const proto = field instanceof HTMLTextAreaElement
                    ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                if (setter) setter.call(field, value);
                else field.value = value;
                field.dispatchEvent(new Event('input', { bubbles: true }));
                field.dispatchEvent(new Event('change', { bubbles: true }));
            }
            field.dispatchEvent(new Event('blur', { bubbles: true }));
            return true;
        }, { labels, value }).catch(() => false);

        if (filled) return;
        await wait(250);
    }
    throw new Error(`فیلد واتساپ پیدا نشد: ${labels.join(' / ')}`);
}

async function getWhatsAppContactState(activePage) {
    return activePage.evaluate((noWhatsAppMessage) => {
        const bodyText = (document.body?.innerText || '')
            .replace(/[’‘`]/g, "'")
            .replace(/\s+/g, ' ')
            .trim();
        const noAccount = bodyText.toLowerCase().includes(noWhatsAppMessage.toLowerCase()) ||
            /this phone number is not on whatsapp/i.test(bodyText) ||
            /the number\s+\+?[\d ()-]+\s+isn't on whatsapp/i.test(bodyText) ||
            /is not on whatsapp/i.test(bodyText);

        if (noAccount) return 'NOT_ON_WHATSAPP';

        const visible = el => {
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 &&
                style.display !== 'none' && style.visibility !== 'hidden' &&
                style.opacity !== '0';
        };
        const viewContact = [...document.querySelectorAll(
            'button,[role="button"],a,div,span,[aria-label],[title]'
        )].some(el => {
            if (!visible(el)) return false;
            const text = [
                el.innerText, el.getAttribute('aria-label'), el.getAttribute('title')
            ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
            return text === 'view contact' || text === 'مشاهده مخاطب' ||
                text === 'نمایش مخاطب';
        });
        if (viewContact) return 'VIEW_CONTACT';

        const saveButton = [...document.querySelectorAll(
            '[data-testid="save-contact-btn"],[aria-label="Save contact"],[aria-label="ذخیره مخاطب"]'
        )].some(visible);
        if (saveButton) return 'SAVE_CONTACT';

        return false;
    }, NO_WHATSAPP_MESSAGE);
}

async function waitForWhatsAppContactState(activePage, timeout = 7000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const state = await getWhatsAppContactState(activePage).catch(() => false);
        if (state) return state;
        await wait(250);
    }
    return false;
}

async function findWhatsAppMessageBox(activePage, timeout = 15000) {
    const selectors = [
        '[contenteditable="true"][aria-label="Type a message"]',
        '[contenteditable="true"][aria-placeholder="Type a message"]',
        '[contenteditable="true"][data-testid="conversation-compose-box-input"]',
        'footer [contenteditable="true"]',
        '[contenteditable="true"]'
    ];
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        for (const selector of selectors) {
            const elements = await activePage.$$(selector).catch(() => []);
            for (const element of elements) {
                const info = await element.evaluate(el => {
                    const rect = el.getBoundingClientRect();
                    const style = getComputedStyle(el);
                    return {
                        visible: rect.width > 0 && rect.height > 0 &&
                            style.display !== 'none' && style.visibility !== 'hidden',
                        aria: el.getAttribute('aria-label') || '',
                        placeholder: el.getAttribute('data-placeholder') ||
                            el.getAttribute('aria-placeholder') || '',
                        tab: el.getAttribute('data-tab') || '',
                        inFooter: Boolean(el.closest('footer'))
                    };
                }).catch(() => null);
                if (!info?.visible) continue;
                const desc = `${info.aria} ${info.placeholder}`.toLowerCase();
                if (desc.includes('search') || desc.includes('جستجو')) continue;
                if (selector === '[contenteditable="true"]' && !info.inFooter &&
                    !desc.includes('type a message') && !desc.includes('پیام')) continue;
                if (info.inFooter || desc.includes('type a message') ||
                    desc.includes('پیام بنویسید') || info.tab === '10' ||
                    selector.includes('conversation-compose-box-input')) return element;
            }
        }
        await wait(250);
    }
    throw new Error('ورودی پیام Type a message در چت پیدا نشد.');
}

async function throwIfWhatsAppAccountMissing(activePage) {
    const missing = await activePage.evaluate((phrase) => {
        const text = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        return text.includes(phrase.toLowerCase()) ||
            /this phone number is not on whatsapp\\.? invite them on your primary device/i.test(text) ||
            /the number\\s+\\+?[\\d ()-]+\\s+isn't on whatsapp/i.test(text);
    }, NO_WHATSAPP_MESSAGE).catch(() => false);
    if (missing) {
        const error = new Error(NO_WHATSAPP_MESSAGE);
        error.code = 'WHATSAPP_ACCOUNT_NOT_FOUND';
        throw error;
    }
}

async function openWhatsAppChatAfterSaving(activePage, phone, timeout = 20000) {
    await throwIfWhatsAppAccountMissing(activePage);
    try {
        return await findWhatsAppMessageBox(activePage, 2500);
    } catch { }

    const searchSelectors = [
        'input[placeholder="Search or start a new chat"]',
        'input[aria-label="Search or start a new chat"]',
        'input[placeholder*="Search or start"]',
        'input[aria-label*="Search or start"]',
        'input[placeholder*="Search name, number"]',
        'input[aria-label*="Search name, number"]',
        'input[placeholder*="جستجو"]',
        'input[aria-label*="جستجو"]',
        '[data-testid="chat-list-search-container"] input'
    ];
    let searchBox = null;
    for (const selector of searchSelectors) {
        for (const element of await activePage.$$(selector).catch(() => [])) {
            const visible = await element.evaluate(isVisibleInPage).catch(() => false);
            if (visible) { searchBox = element; break; }
        }
        if (searchBox) break;
    }
    if (!searchBox) throw new Error('مخاطب ذخیره شد، اما کادر جستجوی چت پیدا نشد.');

    await searchBox.click();
    await activePage.keyboard.down('Control');
    await activePage.keyboard.press('A');
    await activePage.keyboard.up('Control');
    await activePage.keyboard.type(phone, { delay: 35 });
    console.log(`[WhatsAppService] 🔎 شماره مخاطب ذخیره‌شده جستجو شد: ${phone}`);

    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        await throwIfWhatsAppAccountMissing(activePage);
        const point = await activePage.evaluate((phone) => {
            const digits = value => String(value || '').replace(/\D/g, '');
            const visible = el => {
                const rect = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 &&
                    style.display !== 'none' && style.visibility !== 'hidden' &&
                    style.opacity !== '0';
            };
            const matches = el => {
                const raw = String(el.innerText || el.textContent || '').trim();
                if (!raw || raw.length > 1200) return false;
                const lines = raw.split(/\r?\n/).map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
                if (lines.some(line => {
                    const d = digits(line);
                    return d === phone || (d.length > phone.length && d.endsWith(phone));
                })) return true;
                const all = digits(raw);
                return all === phone || (all.length > phone.length && all.endsWith(phone));
            };

            const rows = [...document.querySelectorAll(
                '[data-testid^="list-item-"],[role="row"],[role="listitem"]'
            )].filter(el => visible(el) && matches(el)).map(el => {
                const r = el.getBoundingClientRect();
                return {
                    area: r.width * r.height,
                    x: r.x + r.width / 2,
                    y: r.y + r.height / 2,
                    testid: el.getAttribute('data-testid') || '',
                    role: el.getAttribute('role') || ''
                };
            }).filter(x => x.area > 0);

            if (!rows.length) return null;
            rows.sort((a, b) => a.area - b.area);
            return rows[0];
        }, phone).catch(() => null);

        if (point) {
            await activePage.mouse.click(point.x, point.y);
            console.log(`[WhatsAppService] 🖱️ روی نتیجه جستجو کلیک شد${point.testid ? ` (${point.testid})` : ''}`);
            await wait(1200);
            try {
                return await findWhatsAppMessageBox(activePage, 3000);
            } catch { }
        }
        await wait(300);
    }

    throw new Error('شماره ذخیره‌شده در نتایج جستجو پیدا شد/چت باز نشد؛ پیام ارسال نشد.');
}

export function isWhatsAppNumberUnavailable(mobile) {
    return whatsappUnavailablePhones.has(normalizePhoneForUrlOrLog(mobile));
}

export async function sendTextMessage(mobile, text) {
    const phone = normalizePhoneForUrlOrLog(mobile);
    const message = String(text ?? '').trim();

    if (!phone) {
        return {
            success: false, permanentFailure: true, reason: 'INVALID_PHONE',
            error: 'شماره موبایل وارد نشده است.'
        };
    }
    if (!message) {
        return {
            success: false, permanentFailure: true, reason: 'EMPTY_MESSAGE',
            error: 'متن پیام خالی است.'
        };
    }
    await loadUnavailablePhones();
    if (whatsappUnavailablePhones.has(phone)) {
        return {
            success: false, permanentFailure: true,
            reason: 'WHATSAPP_ACCOUNT_NOT_FOUND',
            error: NO_WHATSAPP_MESSAGE, phone, cached: true
        };
    }

    const activePage = await getActivePage() || await initWhatsAppService();
    if (!activePage || activePage.isClosed()) {
        return {
            success: false, permanentFailure: false, reason: 'WHATSAPP_PAGE_UNAVAILABLE',
            error: 'صفحه واتساپ در دسترس نیست.', phone
        };
    }

    console.log(`[WhatsAppService] 📤 شروع خزش و ارسال متن | شماره: ${phone}`);

    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
        try {
            await activePage.bringToFront().catch(() => { });
            await activePage.goto(WHATSAPP_URL, {
                waitUntil: 'domcontentloaded',
                timeout: ACTION_TIMEOUT
            }).catch(error => {
                console.warn('[WhatsAppService] بازکردن صفحه اصلی واتساپ:', error.message);
            });
            await wait(1800);

            // باز کردن New contact مانند تست موفق Ctrl+Alt+N.
            await activePage.keyboard.down('Control');
            await activePage.keyboard.down('Alt');
            await activePage.keyboard.press('N');
            await activePage.keyboard.up('Alt');
            await activePage.keyboard.up('Control');
            await wait(800);

            let newContactOpened = await clickWhatsAppText(
                activePage,
                ['New contact', 'مخاطب جدید', 'افزودن مخاطب', 'Add contact'],
                2500
            );

            if (!newContactOpened) {
                const newChatButton = await clickWhatsAppSelectors(activePage, [
                    'button[aria-label="New chat"]',
                    'button[aria-label*="New chat"]',
                    '[title="New chat"]',
                    '[data-testid="new-chat-button"]',
                    'button[aria-label*="چت جدید"]',
                    '[title*="چت جدید"]',
                    '[data-testid="chatlist-header"] [role="button"]'
                ], 3000);

                if (newChatButton) {
                    await wait(500);
                    newContactOpened = await clickWhatsAppText(
                        activePage,
                        ['New contact', 'مخاطب جدید', 'افزودن مخاطب', 'Add contact'],
                        5000
                    );
                }
            }

            if (!newContactOpened) {
                throw new Error('گزینه New contact پیدا نشد؛ وضعیت ورود و صفحه اصلی واتساپ را بررسی کن.');
            }

            await wait(700);
            await fillWhatsAppField(activePage, ['First name', 'first name', 'نام کوچک', 'نام'], phone);
            await fillWhatsAppField(activePage, ['Phone', 'phone number', 'شماره تلفن', 'شماره', 'تلفن'], normalizePhoneForContactField(mobile));
            console.log(`[WhatsAppService] شماره در فرم مخاطب وارد شد: ${phone}`);

            // پیش از هر کلیک ذخیره، حالت نبود حساب را صریح بررسی می‌کنیم.
            const contactState = await waitForWhatsAppContactState(activePage, 6500);

            if (contactState === 'NOT_ON_WHATSAPP') {
                await markWhatsAppUnavailable(phone);
                console.warn(`[WhatsAppService] 🚫 ${NO_WHATSAPP_MESSAGE} | شماره: ${phone}`);
                return {
                    success: false,
                    permanentFailure: true,
                    reason: 'WHATSAPP_ACCOUNT_NOT_FOUND',
                    error: NO_WHATSAPP_MESSAGE,
                    phone
                };
            }

            if (contactState === 'VIEW_CONTACT') {
                console.log('[WhatsAppService] مخاطب از قبل ذخیره شده؛ View contact را باز می‌کنم.');
                const clicked = await clickWhatsAppText(
                    activePage,
                    ['View contact', 'مشاهده مخاطب', 'نمایش مخاطب'],
                    5000
                );
                if (!clicked) throw new Error('گزینه View contact دیگر قابل کلیک نیست.');

                await wait(900);
                const closeButton = await clickWhatsAppSelectors(activePage, [
                    'button[aria-label="Close"]',
                    'button[aria-label="close"]',
                    'button[title="Close"]'
                ], 7000);
                if (!closeButton) {
                    const closeText = await clickWhatsAppText(activePage, ['Close', 'بستن'], 2500);
                    if (!closeText) throw new Error('نمای مخاطب باز شد اما دکمه Close پیدا نشد.');
                }
                console.log('[WhatsAppService] نمای مخاطب بسته شد؛ منتظر چت می‌مانم.');
            } else if (contactState === 'SAVE_CONTACT') {
                console.log('[WhatsAppService] مخاطب ذخیره نشده؛ دکمه Save contact را می‌زنم.');
                const saveButton = await clickWhatsAppSelectors(activePage, [
                    '[data-testid="save-contact-btn"]',
                    '[role="button"][aria-label="Save contact"]',
                    'div[aria-label="Save contact"]',
                    '[aria-label="ذخیره مخاطب"]'
                ], 5000);
                if (!saveButton) throw new Error('دکمه Save contact پیدا نشد.');
                await wait(1200);
            } else {
                // نبود پیام خطا به‌تنهایی اثبات نمی‌کند شماره فاقد حساب است.
                throw new Error('پس از واردکردن شماره، واتساپ نه View contact، نه Save contact و نه پیام نبود حساب را نشان داد.');
            }

            let composer;
            try {
                composer = await findWhatsAppMessageBox(activePage, 4500);
            } catch {
                if (contactState === 'VIEW_CONTACT') {
                    throw new Error('پس از بستن نمای مخاطب، ورودی پیام پیدا نشد.');
                }
                composer = await openWhatsAppChatAfterSaving(activePage, phone, 16000);
            }

            // آخرین بررسی قبل از تایپ؛ ممکن است پیام نبود حساب با کمی تأخیر ظاهر شود.
            const bodyText = await activePage.evaluate(() =>
                (document.body?.innerText || '').replace(/\s+/g, ' ').trim()
            ).catch(() => '');
            if (/this phone number is not on whatsapp\.?\s*invite them on your primary device/i.test(bodyText)) {
                await markWhatsAppUnavailable(phone);
                return {
                    success: false,
                    permanentFailure: true,
                    reason: 'WHATSAPP_ACCOUNT_NOT_FOUND',
                    error: NO_WHATSAPP_MESSAGE,
                    phone
                };
            }

            const inputMethod = await pasteWholeMessage(activePage, composer, message);
            console.log(`[WhatsAppService] متن کامل در یک مرحله وارد شد (${inputMethod}) | شماره: ${phone}`);
            await wait(350);

            const typedText = await composer.evaluate(el =>
                (el.innerText || el.textContent || '').trim()
            ).catch(() => '');
            if (!typedText && !await composer.evaluate(el =>
                Boolean(el.querySelector('[data-lexical-text="true"]'))
            ).catch(() => false)) {
                throw new Error('متن در ورودی پیام دیده نشد؛ برای جلوگیری از ارسال خالی، Enter زده نشد.');
            }

            await activePage.keyboard.press('Enter');
            await wait(1000);
            console.log(`[WhatsAppService] ✅ ارسال پیام انجام شد | شماره: ${phone}`);

            return {
                success: true,
                phone,
                message,
                finalUrl: activePage.url()
            };
        } catch (error) {
            if (error?.code === 'WHATSAPP_ACCOUNT_NOT_FOUND' ||
                /this phone number is not on whatsapp/i.test(String(error?.message || ''))) {
                await markWhatsAppUnavailable(phone);
                console.warn(`[WhatsAppService] 🚫 شماره فاقد حساب واتساپ است؛ از ارسال‌های بعدی این اجرا کنار گذاشته شد | ${phone}`);
                return {
                    success: false,
                    permanentFailure: true,
                    reason: 'WHATSAPP_ACCOUNT_NOT_FOUND',
                    error: NO_WHATSAPP_MESSAGE,
                    phone
                };
            }
            console.error(
                `[WhatsAppService] ❌ خطای خزش/ارسال | تلاش ${attempt}/${MAX_SEND_ATTEMPTS} | شماره: ${phone} | ${error.message}`
            );
            if (attempt < MAX_SEND_ATTEMPTS) {
                await wait(RETRY_MS);
                page = await getActivePage();
                if (!page || page.isClosed()) {
                    return {
                        success: false, permanentFailure: false,
                        reason: 'WHATSAPP_PAGE_UNAVAILABLE',
                        error: 'صفحه واتساپ در دسترس نیست.', phone
                    };
                }
            }
        }
    }

    return {
        success: false,
        permanentFailure: false,
        reason: 'WHATSAPP_SEND_FAILED',
        error: 'ارسال پیام واتساپ پس از چند تلاش ناموفق بود.',
        phone
    };
}

async function processWhatsAppActionInternal(mobile, text) {
    return sendTextMessage(mobile, text);
}

async function openWhatsAppChatForImage(activePage, phone) {
    await activePage.bringToFront().catch(() => { });
    await activePage.goto(WHATSAPP_URL, {
        waitUntil: 'domcontentloaded',
        timeout: ACTION_TIMEOUT
    }).catch(error => {
        console.warn('[WhatsAppService] بازکردن صفحه اصلی واتساپ برای عکس:', error.message);
    });
    await wait(1500);

    await activePage.keyboard.down('Control');
    await activePage.keyboard.down('Alt');
    await activePage.keyboard.press('N');
    await activePage.keyboard.up('Alt');
    await activePage.keyboard.up('Control');
    await wait(700);

    let newContactOpened = await clickWhatsAppText(
        activePage,
        ['New contact', 'مخاطب جدید', 'افزودن مخاطب', 'Add contact'],
        2500
    );

    if (!newContactOpened) {
        const newChatButton = await clickWhatsAppSelectors(activePage, [
            'button[aria-label="New chat"]',
            'button[aria-label*="New chat"]',
            '[title="New chat"]',
            '[data-testid="new-chat-button"]',
            'button[aria-label*="چت جدید"]',
            '[title*="چت جدید"]',
            '[data-testid="chatlist-header"] [role="button"]'
        ], 3000);
        if (newChatButton) {
            await wait(500);
            newContactOpened = await clickWhatsAppText(
                activePage,
                ['New contact', 'مخاطب جدید', 'افزودن مخاطب', 'Add contact'],
                4000
            );
        }
    }

    if (!newContactOpened) {
        throw new Error('گزینه New contact برای ارسال عکس پیدا نشد؛ ورود واتساپ را بررسی کن.');
    }

    await wait(600);
    await fillWhatsAppField(activePage, ['First name', 'first name', 'نام کوچک', 'نام'], phone);
    await fillWhatsAppField(activePage, ['Phone', 'phone number', 'شماره تلفن', 'شماره', 'تلفن'], normalizePhoneForContactField(mobile));

    const contactState = await waitForWhatsAppContactState(activePage, 6500);
    if (contactState === 'NOT_ON_WHATSAPP') {
        await markWhatsAppUnavailable(phone);
        const error = new Error(NO_WHATSAPP_MESSAGE);
        error.code = 'WHATSAPP_ACCOUNT_NOT_FOUND';
        throw error;
    }

    if (contactState === 'VIEW_CONTACT') {
        const clicked = await clickWhatsAppText(
            activePage,
            ['View contact', 'مشاهده مخاطب', 'نمایش مخاطب'],
            5000
        );
        if (!clicked) throw new Error('گزینه View contact پیدا نشد.');
        await wait(800);
        const closeButton = await clickWhatsAppSelectors(activePage, [
            'button[aria-label="Close"]',
            'button[aria-label="close"]',
            'button[title="Close"]'
        ], 6000);
        if (!closeButton && !await clickWhatsAppText(activePage, ['Close', 'بستن'], 2000)) {
            throw new Error('دکمه Close در نمای مخاطب پیدا نشد.');
        }
    } else if (contactState === 'SAVE_CONTACT') {
        const saveButton = await clickWhatsAppSelectors(activePage, [
            '[data-testid="save-contact-btn"]',
            '[role="button"][aria-label="Save contact"]',
            'div[aria-label="Save contact"]',
            '[aria-label="ذخیره مخاطب"]'
        ], 5000);
        if (!saveButton) throw new Error('دکمه Save contact پیدا نشد.');
        await wait(1000);
    } else {
        await throwIfWhatsAppAccountMissing(activePage);
        throw new Error('وضعیت مخاطب برای ارسال عکس مشخص نشد.');
    }

    try {
        return await findWhatsAppMessageBox(activePage, 4500);
    } catch {
        return await openWhatsAppChatAfterSaving(activePage, phone, 16000);
    }
}

async function processWhatsAppImageActionInternal(
    mobile,
    imagePath,
    caption = ''
) {
    const phone = normalizePhoneForUrlOrLog(mobile);
    const image = path.resolve(String(imagePath || ''));
    const message = String(caption ?? '').trim();

    if (!phone) {
        return { success: false, permanentFailure: true, reason: 'INVALID_PHONE', error: 'شماره موبایل وارد نشده است.' };
    }
    if (!imagePath) {
        return { success: false, permanentFailure: true, reason: 'IMAGE_PATH_MISSING', error: 'مسیر فایل عکس وارد نشده است.', phone };
    }
    try {
        await fs.access(image);
    } catch {
        return { success: false, permanentFailure: true, reason: 'IMAGE_FILE_NOT_FOUND', error: `فایل عکس پیدا نشد: ${image}`, phone };
    }

    await loadUnavailablePhones();
    if (whatsappUnavailablePhones.has(phone)) {
        return {
            success: false, permanentFailure: true,
            reason: 'WHATSAPP_ACCOUNT_NOT_FOUND', error: NO_WHATSAPP_MESSAGE,
            phone, cached: true
        };
    }

    let activePage = await getActivePage() || await initWhatsAppService();
    if (!activePage || activePage.isClosed()) {
        return { success: false, permanentFailure: false, reason: 'WHATSAPP_PAGE_UNAVAILABLE', error: 'صفحه واتساپ در دسترس نیست.', phone };
    }

    console.log(`[WhatsAppService] 🖼️ شروع ارسال عکس${message ? ' همراه متن' : ''} | شماره: ${phone}`);

    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
        try {
            const composer = await openWhatsAppChatForImage(activePage, phone);
            await throwIfWhatsAppAccountMissing(activePage);

            // ابتدا کنترل پیوست را باز می‌کنیم؛ سپس فایل را از طریق input[type=file] بارگذاری می‌کنیم.
            let fileInputs = await activePage.$$('input[type="file"]');
            if (!fileInputs.length) {
                await clickWhatsAppSelectors(activePage, [
                    '[data-testid="conversation-clip"]',
                    'button[aria-label="Attach"]',
                    'button[aria-label*="Attach"]',
                    '[title="Attach"]',
                    '[data-icon="plus-rounded"]',
                    '[data-icon="attach-menu-plus"]'
                ], 5000);
                await wait(400);
                fileInputs = await activePage.$$('input[type="file"]');
            }
            if (!fileInputs.length) {
                throw new Error('ورودی بارگذاری فایل عکس در واتساپ پیدا نشد.');
            }

            let uploaded = false;
            for (const input of fileInputs) {
                const accept = await input.evaluate(el => el.getAttribute('accept') || '').catch(() => '');
                if (accept && !/image|\*/i.test(accept)) continue;
                try {
                    await input.uploadFile(image);
                    uploaded = true;
                    break;
                } catch { }
            }
            if (!uploaded) throw new Error('فایل عکس به واتساپ پیوست نشد.');
            await wait(1200);

            if (message) {
                // پس از انتخاب عکس، واتساپ معمولاً یک کادر توضیح جداگانه در پیش‌نمایش نشان می‌دهد.
                const captionSelectors = [
                    '[contenteditable="true"][aria-label*="caption" i]',
                    '[contenteditable="true"][data-testid*="caption"]',
                    '[contenteditable="true"][aria-label*="توضیح"]',
                    '[contenteditable="true"][data-tab="10"]',
                    '[contenteditable="true"]'
                ];
                let captionBox = null;
                for (const selector of captionSelectors) {
                    const elements = await activePage.$$(selector).catch(() => []);
                    for (const el of elements) {
                        const info = await el.evaluate(node => {
                            const r = node.getBoundingClientRect();
                            const st = getComputedStyle(node);
                            return {
                                visible: r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden',
                                text: (node.innerText || node.textContent || '').trim(),
                                aria: node.getAttribute('aria-label') || '',
                                placeholder: node.getAttribute('data-placeholder') || node.getAttribute('aria-placeholder') || '',
                                footer: Boolean(node.closest('footer'))
                            };
                        }).catch(() => null);
                        if (!info?.visible || info.footer) continue;
                        const desc = `${info.aria} ${info.placeholder}`.toLowerCase();
                        if (desc.includes('search') || desc.includes('جستجو') || desc.includes('type a message')) continue;
                        captionBox = el;
                        break;
                    }
                    if (captionBox) break;
                }
                if (!captionBox) {
                    throw new Error('کادر متن توضیح عکس در پیش‌نمایش واتساپ پیدا نشد؛ برای جلوگیری از ارسال عکس بدون متن ارسال متوقف شد.');
                }
                const inputMethod = await pasteWholeMessage(activePage, captionBox, message);
                console.log(`[WhatsAppService] متن کامل توضیح عکس در یک مرحله وارد شد (${inputMethod}) | شماره: ${phone}`);
                await wait(250);
            }

            const sendButton = await clickWhatsAppSelectors(activePage, [
                '[data-testid="send"]',
                'button[aria-label="Send"]',
                'button[aria-label*="Send"]',
                'button[aria-label="ارسال"]',
                '[data-icon="send"]'
            ], 7000);
            if (!sendButton) {
                // بعض نسخه‌ها دکمه را با آیکون داخلی نشان می‌دهند؛ کلیک روی خود آیکون هم امتحان می‌شود.
                const clicked = await clickWhatsAppText(activePage, ['Send', 'ارسال'], 2000);
                if (!clicked) throw new Error('دکمه ارسال عکس در پیش‌نمایش پیدا نشد.');
            }

            await wait(1200);
            console.log(`[WhatsAppService] ✅ ارسال عکس${message ? ' همراه متن' : ''} انجام شد | شماره: ${phone}`);
            return { success: true, phone, imagePath: image, caption: message, finalUrl: activePage.url() };
        } catch (error) {
            if (error?.code === 'WHATSAPP_ACCOUNT_NOT_FOUND' ||
                /this phone number is not on whatsapp|isn't on whatsapp/i.test(String(error?.message || ''))) {
                await markWhatsAppUnavailable(phone);
                console.warn(`[WhatsAppService] 🚫 شماره فاقد حساب واتساپ است | ${phone}`);
                return {
                    success: false, permanentFailure: true,
                    reason: 'WHATSAPP_ACCOUNT_NOT_FOUND', error: NO_WHATSAPP_MESSAGE, phone
                };
            }
            console.error(`[WhatsAppService] ❌ خطای ارسال عکس | تلاش ${attempt}/${MAX_SEND_ATTEMPTS} | شماره: ${phone} | ${error.message}`);
            if (attempt < MAX_SEND_ATTEMPTS) {
                await wait(RETRY_MS);
                activePage = await getActivePage();
                if (!activePage || activePage.isClosed()) {
                    return { success: false, permanentFailure: false, reason: 'WHATSAPP_PAGE_UNAVAILABLE', error: 'صفحه واتساپ در دسترس نیست.', phone };
                }
            }
        }
    }

    return {
        success: false, permanentFailure: false,
        reason: 'WHATSAPP_IMAGE_SEND_FAILED',
        error: 'ارسال عکس واتساپ پس از چند تلاش ناموفق بود.', phone
    };
}

export const processWhatsAppAction = (
    mobile,
    text
) => {
    const run = actionQueue.then(() =>
        processWhatsAppActionInternal(mobile, text)
    );

    actionQueue = run.catch(() => { });
    return run;
};

export const processWhatsAppImageAction = (
    mobile,
    imagePath,
    caption = ''
) => {
    const run = actionQueue.then(() =>
        processWhatsAppImageActionInternal(
            mobile,
            imagePath,
            caption
        )
    );

    actionQueue = run.catch(() => { });
    return run;
};

export const processWhatsAppImageCaptionAction =
    processWhatsAppImageAction;

export const processWhatsAppImageWithCaptionAction =
    processWhatsAppImageAction;

export function isWhatsAppConfigured() {
    return true;
}