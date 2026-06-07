// Feature: after-party-lottery, Property 20: Lottery panel render invariants
//
// @vitest-environment jsdom
//
// Validates: Requirements 10.2, 10.3, 10.4, 10.7
//
// Property 20 asserts the DOM-shape invariants of `renderLotteryPanel` from
// web/lottery/panel-render.mjs (the canonical mirror of the inline copy in
// signal_hunt.html), across the four progress-response cases from design §3:
//
//   case 1 — `lotteryEligible` key absent (before the time gate):
//            panel hidden, no nickname input rendered (Req 10.3).
//   case 2 — lotteryEligible:false (not eligible, has lotteryReason +
//            stationsRemaining): panel visible, NO nickname input form, shows a
//            Simplified-Chinese reason message via reasonToZh (Req 10.4).
//   case 3 — lotteryEligible:true WITH a nickname (registered): panel visible,
//            shows the registered nickname text (exact, escaped), shows the
//            confirmed label "✓ 已成功登记参与抽奖", no nickname input (Req 10.2).
//   case 4 — lotteryEligible:true WITHOUT a nickname (eligible): panel visible,
//            nickname input form present (#nickname-form / #nickname-input).
//
// All visible labels must be Simplified Chinese (Req 10.7).

import { describe, it, expect, beforeEach } from 'vitest';
import fc from 'fast-check';

import { renderLotteryPanel, reasonToZh } from '../../panel-render.mjs';

// ---------------------------------------------------------------------------
// Test fixtures / helpers
// ---------------------------------------------------------------------------

/** (Re)create a fresh #lottery-panel element so each render starts clean. */
function setupPanel() {
  document.body.innerHTML =
    '<section class="panel lottery-panel" id="lottery-panel" hidden></section>';
  return document.getElementById('lottery-panel');
}

// Any non-ASCII char in a string is a quick proxy for "contains CJK / SC text".
// All of our literal labels and reasonToZh outputs contain Han characters, so
// every rendered label must include at least one char with code point > 127.
function hasNonAscii(text) {
  return /[^\u0000-\u007F]/.test(text);
}

const ASCII_LATIN_PUNCT_RE = /^[\u0020-\u007E]+$/;

// The four machine-readable reason codes the backend can emit, plus an unknown
// code that should fall through to the generic Simplified-Chinese message.
const arbReason = fc.constantFrom(
  'incomplete_stations',
  'after_party_checkin_required',
  'incomplete_stations_and_no_after_party_checkin',
  'unknown_reason_code',
);

const arbStationsRemaining = fc.integer({ min: 0, max: 10 });

// Nicknames: cover Latin, CJK, emoji, and HTML-significant characters so the
// escape + exact-equality invariant is exercised broadly. 1-20 chars.
const arbNickname = fc.oneof(
  fc.string({ minLength: 1, maxLength: 20 }),
  fc.constantFrom('Alice', '小明', '🎉派对', 'a&b<c>"d', "O'Brien", '<script>'),
);

// ---------------------------------------------------------------------------

describe('Property 20: Lottery panel render invariants', () => {
  beforeEach(() => {
    setupPanel();
  });

  // -- case 1 -------------------------------------------------------------
  it('case 1 — lotteryEligible absent ⇒ panel hidden, no nickname input', () => {
    // Generate arbitrary objects that NEVER contain the `lotteryEligible` key,
    // plus the null/undefined edge cases (before the time gate the backend omits
    // the field entirely).
    const arbProgressNoKey = fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.record(
        {
          tagId: fc.string(),
          totalCheckins: fc.integer({ min: 0, max: 10 }),
          completed: fc.boolean(),
          afterPartyEligible: fc.boolean(),
          stationsRemaining: arbStationsRemaining,
        },
        { requiredKeys: [] },
      ),
    );

    fc.assert(
      fc.property(arbProgressNoKey, (progress) => {
        const panel = setupPanel();
        renderLotteryPanel(progress);

        expect(panel.hidden).toBe(true);
        expect(panel.innerHTML).toBe('');
        expect(document.getElementById('nickname-input')).toBeNull();
        expect(document.getElementById('nickname-form')).toBeNull();
      }),
    );
  });

  // -- case 2 -------------------------------------------------------------
  it('case 2 — lotteryEligible:false ⇒ visible, no input, SC reason message', () => {
    fc.assert(
      fc.property(arbReason, arbStationsRemaining, (reason, stationsRemaining) => {
        const panel = setupPanel();
        renderLotteryPanel({
          lotteryEligible: false,
          lotteryReason: reason,
          stationsRemaining,
        });

        // Panel visible (Req 10.4).
        expect(panel.hidden).toBe(false);

        // No nickname input form must be rendered for ineligible participants.
        expect(document.getElementById('nickname-form')).toBeNull();
        expect(document.getElementById('nickname-input')).toBeNull();

        // The exact Simplified-Chinese reason message must be present (Req 10.4).
        const expected = reasonToZh(reason, stationsRemaining);
        const statusEl = panel.querySelector('.lottery-status.pending');
        expect(statusEl).not.toBeNull();
        expect(statusEl.textContent).toBe(expected);

        // All visible labels are Simplified Chinese (Req 10.7).
        expect(hasNonAscii(panel.querySelector('h3').textContent)).toBe(true);
        expect(hasNonAscii(statusEl.textContent)).toBe(true);
      }),
    );
  });

  // -- case 3 -------------------------------------------------------------
  it('case 3 — nickname present ⇒ visible, shows escaped nickname + confirm label, no input', () => {
    fc.assert(
      fc.property(arbNickname, (nickname) => {
        const panel = setupPanel();
        renderLotteryPanel({ lotteryEligible: true, nickname });

        // Panel visible (Req 10.2).
        expect(panel.hidden).toBe(false);

        // No nickname input in the registered state.
        expect(document.getElementById('nickname-form')).toBeNull();
        expect(document.getElementById('nickname-input')).toBeNull();

        // Confirmed label exactly matches the Simplified-Chinese literal (Req 10.2).
        const confirmEl = panel.querySelector('.lottery-status.confirmed');
        expect(confirmEl).not.toBeNull();
        expect(confirmEl.textContent).toBe('✓ 已成功登记参与抽奖');

        // The registered nickname text is shown with exact equality. Because the
        // value is HTML-escaped before injection, reading textContent back must
        // yield the original nickname verbatim (Req 10.2).
        const nickEl = panel.querySelector('.lottery-nickname strong');
        expect(nickEl).not.toBeNull();
        expect(nickEl.textContent).toBe(nickname);

        // Escaping defence (XSS): the nickname must be rendered as TEXT, never
        // parsed into child elements. If escapeHtml were skipped, a value like
        // "<script>" would inject an element and `children.length` would be > 0
        // (and the textContent equality above would also fail). Checking for the
        // absence of element children is robust to jsdom's entity re-serialization
        // (e.g. `&#39;` round-trips back to a literal apostrophe in innerHTML).
        expect(nickEl.children.length).toBe(0);

        // Labels (heading + confirm) are Simplified Chinese (Req 10.7).
        expect(hasNonAscii(panel.querySelector('h3').textContent)).toBe(true);
        expect(hasNonAscii(confirmEl.textContent)).toBe(true);
      }),
    );
  });

  // -- case 4 -------------------------------------------------------------
  it('case 4 — eligible, no nickname ⇒ visible, nickname input form present', () => {
    // The eligible-without-nickname case is structurally fixed, but we vary the
    // absent/empty representations of `nickname` that all mean "not registered".
    const arbNoNickname = fc.constantFrom(undefined, '', null);

    fc.assert(
      fc.property(arbNoNickname, (nickname) => {
        const panel = setupPanel();
        const progress = { lotteryEligible: true };
        if (nickname !== undefined) progress.nickname = nickname;
        renderLotteryPanel(progress);

        // Panel visible (Req 10.1).
        expect(panel.hidden).toBe(false);

        // Nickname input form present with the expected element ids (Req 10.1).
        const form = document.getElementById('nickname-form');
        const input = document.getElementById('nickname-input');
        expect(form).not.toBeNull();
        expect(input).not.toBeNull();
        expect(form.tagName).toBe('FORM');
        expect(input.tagName).toBe('INPUT');
        expect(input.getAttribute('maxlength')).toBe('20');

        // Visible heading + prompt + button labels are Simplified Chinese (Req 10.7).
        expect(hasNonAscii(panel.querySelector('h3').textContent)).toBe(true);
        expect(hasNonAscii(panel.querySelector('button').textContent)).toBe(true);
      }),
    );
  });

  // -- cross-cutting: Req 10.7 (every visible text node is Simplified Chinese) --
  it('Req 10.7 — every visible label across the three rendered states is non-ASCII Chinese', () => {
    // For the three states that render content (cases 2, 3, 4), assert that no
    // visible label is pure ASCII-Latin text. User-supplied nicknames are exempt
    // (they may legitimately be Latin), so we only check structural labels.
    const arbState = fc.oneof(
      fc.record({ kind: fc.constant('not_eligible'), reason: arbReason, rem: arbStationsRemaining }),
      fc.record({ kind: fc.constant('registered') }),
      fc.record({ kind: fc.constant('eligible') }),
    );

    fc.assert(
      fc.property(arbState, (st) => {
        const panel = setupPanel();
        if (st.kind === 'not_eligible') {
          renderLotteryPanel({ lotteryEligible: false, lotteryReason: st.reason, stationsRemaining: st.rem });
        } else if (st.kind === 'registered') {
          renderLotteryPanel({ lotteryEligible: true, nickname: 'Alice' });
        } else {
          renderLotteryPanel({ lotteryEligible: true });
        }

        // Structural label selectors per state.
        const labelSelectors = ['h3', 'button', '.lottery-status', 'p'];
        for (const sel of labelSelectors) {
          for (const el of panel.querySelectorAll(sel)) {
            // Skip the nickname-bearing element (user content may be Latin).
            if (el.classList.contains('lottery-nickname')) continue;
            const text = el.textContent.trim();
            if (text.length === 0) continue;
            // A label is acceptable if it is NOT pure ASCII-Latin punctuation/letters.
            if (ASCII_LATIN_PUNCT_RE.test(text)) {
              // The only all-ASCII structural text we tolerate is the bare "✓"-less
              // case — but all our labels include Han characters, so this should
              // never be reached. Assert non-ASCII to surface regressions.
              expect(hasNonAscii(text)).toBe(true);
            }
          }
        }
      }),
    );
  });
});
