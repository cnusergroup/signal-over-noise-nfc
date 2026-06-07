// After Party Lottery — Progress Page panel renderer.
//
// This module is the canonical, testable copy of the lottery-panel rendering
// logic that also lives inline inside `signal_hunt.html` (Progress Page).
// `signal_hunt.html` runs a single non-module IIFE `<script>`, so it keeps an
// inline copy of `escapeHtml`, `reasonToZh`, and `renderLotteryPanel` that MUST
// stay byte-for-byte identical to the functions exported here. Keeping this ES
// module mirror lets the DOM-shape invariants (design §3, Requirements 10.2,
// 10.3, 10.4, 10.7) be verified by Vitest + jsdom without loading the full page.
//
// Requirements: 10.1, 10.2, 10.3, 10.4, 10.7

/**
 * Escape user-supplied values before injecting them into innerHTML.
 * @param {*} value - Any value; null/undefined become an empty string.
 * @returns {string} The HTML-escaped string.
 */
export function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Map a machine-readable lottery reason to a Simplified-Chinese message.
 * @param {string} reason - One of the machine-readable reason codes.
 * @param {number} stationsRemaining - Number of stations still to complete.
 * @returns {string} A Simplified-Chinese status message.
 */
export function reasonToZh(reason, stationsRemaining) {
  if (reason === 'incomplete_stations')
    return '还需完成 ' + stationsRemaining + ' 个站点的打卡';
  if (reason === 'after_party_checkin_required')
    return '请在 After Party 时段（17:00 后）完成至少一次打卡';
  if (reason === 'incomplete_stations_and_no_after_party_checkin')
    return '还需完成 ' + stationsRemaining + ' 个站点的打卡，并在 17:00 后再次打卡';
  return '暂不符合抽奖资格';
}

/**
 * Conditionally render the lottery panel based on the progress response.
 * `progress` is the JSON returned by GET /checkin/{tagId}.
 *
 * Behaviour (design §3):
 *  - `lotteryEligible` absent (before time gate) → panel hidden, no UI (Req 10.3).
 *  - `progress.nickname` present → registered view with confirm label (Req 10.2).
 *  - eligible without nickname → nickname input form (Req 10.1).
 *  - not eligible → Simplified-Chinese reason message (Req 10.4).
 *
 * @param {object|null|undefined} progress - The progress response JSON.
 * @param {Function} [onNicknameSubmit] - Optional submit handler wired to the
 *   nickname form when it is rendered. Omitted in pure render tests.
 */
export function renderLotteryPanel(progress, onNicknameSubmit) {
  var panel = document.getElementById('lottery-panel');
  if (!panel) return;

  // Before the time gate the backend omits lotteryEligible entirely;
  // in that case no lottery UI is shown (Requirement 10.3).
  if (!progress || !('lotteryEligible' in progress)) {
    panel.hidden = true;
    panel.innerHTML = '';
    return;
  }

  panel.hidden = false;

  // Already registered → show nickname + enrollment-confirmed label (Req 10.2).
  if (progress.nickname) {
    panel.innerHTML =
      '<h3>抽奖资格</h3>' +
      '<p class="lottery-status confirmed">✓ 已成功登记参与抽奖</p>' +
      '<p class="lottery-nickname">昵称：<strong>' + escapeHtml(progress.nickname) + '</strong></p>';
    return;
  }

  // Eligible but not registered → show the nickname input form (Req 10.1).
  if (progress.lotteryEligible) {
    panel.innerHTML =
      '<h3>抽奖资格</h3>' +
      '<p>恭喜！您符合参加抽奖的条件，请输入您的昵称：</p>' +
      '<form id="nickname-form" class="nickname-form" novalidate>' +
        '<label for="nickname-input">抽奖昵称</label>' +
        '<input id="nickname-input" name="nickname" type="text" maxlength="20" required ' +
          'autocomplete="off" placeholder="1-20 个字符" />' +
        '<button type="submit">登记</button>' +
      '</form>' +
      '<p id="nickname-error" class="error" hidden></p>';
    var form = document.getElementById('nickname-form');
    if (form && typeof onNicknameSubmit === 'function') {
      form.addEventListener('submit', onNicknameSubmit);
    }
    return;
  }

  // Not eligible → show a Simplified-Chinese reason message (Req 10.4).
  panel.innerHTML =
    '<h3>抽奖资格</h3>' +
    '<p class="lottery-status pending">' +
      escapeHtml(reasonToZh(progress.lotteryReason, progress.stationsRemaining)) +
    '</p>';
}
