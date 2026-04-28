// space201 폼 신청 처리 API
// 1. 구글 시트에 신청 정보 저장
// 2. 텔레그램 단톡방에 알림 전송

import { google } from 'googleapis';

// 한국 시간 포맷
function getKST() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const yyyy = kst.getUTCFullYear();
  const mm = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(kst.getUTCDate()).padStart(2, '0');
  const hh = String(kst.getUTCHours()).padStart(2, '0');
  const mi = String(kst.getUTCMinutes()).padStart(2, '0');
  const ss = String(kst.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

// 인테리어 종류 한글 변환
function typeKr(t) {
  if (t === 'commercial') return '상업 인테리어';
  if (t === 'residential') return '주거 인테리어';
  return t || '미지정';
}

// 구글 시트에 한 줄 추가
async function appendToSheet(row) {
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const sheets = google.sheets({ version: 'v4', auth });

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'A:F',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [row],
    },
  });
}

// 텔레그램 메시지 전송
async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: text,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Telegram failed: ${err}`);
  }
}

export default async function handler(req, res) {
  // CORS 처리 (혹시 모를 상황 대비)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { name, phone, type, region, budget } = req.body || {};

    // 필수값 검증
    if (!name || !phone) {
      return res.status(400).json({ error: '이름과 전화번호는 필수입니다.' });
    }

    // 봇/스팸 간단 차단 (전화번호 형식)
    const phoneClean = phone.replace(/[^0-9]/g, '');
    if (phoneClean.length < 9 || phoneClean.length > 11) {
      return res.status(400).json({ error: '전화번호 형식이 올바르지 않습니다.' });
    }

    const kst = getKST();
    const typeLabel = typeKr(type);
    const regionLabel = region || '미지정';
    const budgetLabel = budget || '미지정';

    // 1) 시트 추가 + 2) 텔레그램 동시 처리 (Promise.allSettled로 한쪽 실패해도 나머지 실행)
    const sheetRow = [kst, name, phone, typeLabel, regionLabel, budgetLabel];
    const tgText =
      `🔔 신청 접수\n` +
      `${name} / ${phone}\n` +
      `${typeLabel} / ${regionLabel} / ${budgetLabel}`;

    const [sheetResult, tgResult] = await Promise.allSettled([
      appendToSheet(sheetRow),
      sendTelegram(tgText),
    ]);

    const sheetOk = sheetResult.status === 'fulfilled';
    const tgOk = tgResult.status === 'fulfilled';

    // 둘 다 실패하면 에러
    if (!sheetOk && !tgOk) {
      console.error('Sheet error:', sheetResult.reason);
      console.error('Telegram error:', tgResult.reason);
      // 마지막 시도 - 백업 알림 (시트 누락 데이터 텔레그램으로 강제 전송)
      try {
        await sendTelegram(
          `⚠️ 시스템 오류 - 수동 처리 필요\n` +
          `${kst}\n${name} / ${phone}\n${typeLabel} / ${regionLabel} / ${budgetLabel}`
        );
      } catch (e) {
        // 텔레그램도 안 가면 답변에 데이터 포함
        return res.status(500).json({
          error: '시스템 오류',
          backup: { kst, name, phone, type: typeLabel, region: regionLabel, budget: budgetLabel },
        });
      }
      return res.status(500).json({ error: '시트 저장 실패. 텔레그램으로 백업 전송됨.' });
    }

    // 한쪽만 실패하면 부분 성공으로 처리하고 알림
    if (!sheetOk) {
      console.error('Sheet error:', sheetResult.reason);
      try {
        await sendTelegram(`⚠️ 시트 저장 실패 - 수동 입력 필요\n${kst} / ${name} / ${phone} / ${typeLabel} / ${regionLabel} / ${budgetLabel}`);
      } catch (e) {}
    }
    if (!tgOk) {
      console.error('Telegram error:', tgResult.reason);
    }

    return res.status(200).json({
      success: true,
      sheet: sheetOk,
      telegram: tgOk,
    });
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
}
