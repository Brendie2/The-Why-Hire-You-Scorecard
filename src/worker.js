/* Scorecard worker. Serves the site and handles POST /api/scorecard.
   When someone enters their name + email (with consent) before seeing results:
     1) BREVO   saves/updates the contact (the "table"): scores, primary gap, consent, results link
     2) RESEND  emails Brenda: "This person took the Scorecard", with the full results
     3) RESEND  emails the person: "Your results are in" with their results link
   New in this version: the opener answer (SEGMENT), two routing answers (READY_TO_DELIVER, HELP_WANTED) and the free-text QUESTION are saved and emailed.
   In Brevo, create these TEXT contact attributes once: SEGMENT, SEGMENT_LABEL, READY_TO_DELIVER, HELP_WANTED, QUESTION,
   and rename the three changed answer attributes: Q05_OFFER_COMMITMENT, Q06_OFFER_PRICE, Q09_CONFIDENCE (until then the save falls back safely).
   Variables and Secrets (Settings > Variables and Secrets):
     BREVO_API_KEY (Secret) · BREVO_LIST_ID
     RESEND_API_KEY (Secret) · RESEND_FROM  e.g.  Brenda Blanche <hello@brendablanche.site>
     NOTIFY_EMAIL           where Brenda's notifications go                                          */

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
const t = v => String(v ?? '').trim().slice(0, 300);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const DIMS = ['Market & Problem Clarity', 'Offer Design', 'Positioning & Differentiation', 'Evidence & Trust', 'Market Signals & Recognition', 'Buyer Journey & Conversion'];
const QKEYS = ['Q01_BUYER_TYPE', 'Q02_BUYER_PROBLEM', 'Q03_PROBLEM_EVIDENCE', 'Q04_OFFER_CLARITY', 'Q05_OFFER_COMMITMENT', 'Q06_OFFER_PRICE', 'Q07_POSITIONING_FIT', 'Q08_DIFFERENTIATION', 'Q09_CONFIDENCE',
  'Q10_ABILITY_PROOF', 'Q11_OBJECTIONS', 'Q12_EXPECTATIONS', 'Q13_MESSAGE_CONSISTENCY', 'Q14_KNOWN_FOR', 'Q15_VISIBILITY_METHOD', 'Q16_NEXT_STEP', 'Q17_PATH_TO_BUYING', 'Q18_LEARNING_LOOP'];
const QLABELS = ['Who needs your expertise', 'The buyer\'s problem in their words', 'Evidence the problem matters', 'Can a buyer say what to hire you for', 'Choosing one service to lead with', 'What the price is based on',
  'Why your work matters (quick read)', 'What makes your approach different', 'How it feels to say why you are the right person', 'What a buyer can see of your ability', 'Handling buyer hesitations', 'What working with you involves',
  'Consistency across profile, offer, content', 'Would a follower know what you\'re known for', 'Deliberate way to make value visible', 'Is the next step clear', 'Path from discovery to considering you', 'Learning from buyer questions and decisions'];
const cleanAnswers = raw => Array.isArray(raw) && raw.length === 18 ? raw.map(x => ({ s: [1, 2, 3, 4].includes(Number(x?.s)) ? Number(x.s) : 0, t: String(x?.t ?? '').trim().slice(0, 160) })) : null;
const FRIENDLY = { 'Market & Problem Clarity': 'Who you help', 'Offer Design': 'What exactly you sell', 'Positioning & Differentiation': 'Why they should pick you', 'Evidence & Trust': 'Why they can trust you', 'Market Signals & Recognition': 'What people see online', 'Buyer Journey & Conversion': 'What happens after they\'re interested' };
const SEGL = { A: 'I can do the work, but I can\'t say what someone should hire me for.', B: 'I can do lots of things and I can\'t pick a lead service.', C: 'I have real experience, but people with less of it get the opportunities.', D: 'I post and have some audience, but nobody asks to work with me.', E: 'People show interest, then go quiet, or say it\'s too expensive.', X: 'Not sure, probably a mix' };
const READYL = { 1: 'Yes, has done similar work and could start soon', 2: 'Mostly, would want to prepare first', 3: 'Not sure, has not delivered it for someone yet', 4: 'Not yet, still building the skill' };
const HELPL = { 1: 'Work on it myself first', 2: 'One conversation about their situation', 3: 'Guided one-on-one help', 4: 'Not sure yet' };
const q600 = v => String(v ?? '').trim().slice(0, 600);
const fr = n => FRIENDLY[n] || n;
const band = s => s >= 10 ? 'Stronger foundation' : s >= 7 ? 'Inconsistent or incomplete' : 'Priority to investigate';
const gapNames = v => String(v || '').split(' + ').filter(x => DIMS.includes(x));   // only known dimension names are ever put in an email

const brevo = (env, body) => fetch('https://api.brevo.com/v3/contacts', { method: 'POST',
  headers: { 'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
const resend = (env, to, subject, html, replyTo) => fetch('https://api.resend.com/emails', { method: 'POST',
  headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' },
  body: JSON.stringify({ from: env.RESEND_FROM, to: [to], subject, html, ...(replyTo ? { reply_to: replyTo } : {}) }) });

const P = 'margin:0 0 18px;font:17px/1.65 Georgia,\'Times New Roman\',serif;color:#14100F';
function firstEmail(name, kind, gaps, url, consent, seg) {
  const g = gaps.map(fr).join(' + ');
  const line = kind === 'single' && g ? `Your lowest-scoring area was <b>${esc(g)}</b>. That is where your answers suggest it may be worth looking first.`
    : kind === 'combined' && g ? `More than one area scored equally low: <b>${esc(g)}</b>. Your answers suggest the gap may not sit in just one place.`
    : kind === 'strong' ? 'None of your six areas scored in the lower bands. Your results page explains how to check whether your market-facing evidence supports that.' : '';
  const btn = l => `<p style="margin:6px 0 24px"><a href="${esc(url)}" style="display:inline-block;background:#E4007C;color:#ffffff;text-decoration:none;font:600 15px Arial,sans-serif;letter-spacing:.04em;padding:14px 26px;border-radius:999px">${l}</a></p>`;
  return `<!DOCTYPE html><html><body style="margin:0;background:#ffffff"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 16px"><table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%"><tr><td>
<p style="${P}">Hi ${esc(name)},</p><p style="${P}">Your Why-Hire-You Scorecard results are ready.</p>${btn('VIEW YOUR RESULTS')}
${seg && seg !== 'X' ? `<p style="${P}">You told us this sounds most like you: <i>&ldquo;${esc(SEGL[seg])}&rdquo;</i></p>` : ''}<p style="${P}">Your answers look at six areas that decide whether people understand what you sell, trust you, and say yes:</p>
<ul style="margin:0 0 18px;padding-left:22px;font:17px/1.65 Georgia,serif;color:#14100F">${DIMS.map(d => `<li>${esc(fr(d))}</li>`).join('')}</ul>
<p style="${P}">As you review your breakdown, pay attention to the area or areas that scored lowest.</p>
${line ? `<p style="${P}">${line}</p>` : ''}
<p style="${P}">That is a useful starting point. It isn't proof of the problem. Your answers show where to look, not exactly what every buyer thinks.</p>
<p style="${P}">Here's one exercise to begin with:</p><p style="${P}">Ask yourself: What would a stranger need to understand, believe or see before they felt safe saying yes to me?</p>
<p style="${P}">Write down your answer. Then compare it with what your profile, posts, offer and proof actually say.</p><p style="${P}">You may notice a gap worth fixing.</p>
<p style="${P}">${consent ? `Over the next few days, I'll share some practical ways to look at that gap, without assuming you need to post more, redesign everything, or change your whole business.` : `When you're ready, your results page also shows some practical next steps, including how to book a Clarity Call or message me on WhatsApp.`}</p>
<p style="${P}">Start with your results here:</p>${btn('VIEW MY RESULTS')}<p style="${P}">Brenda</p>
<p style="margin:0;padding-top:18px;border-top:1px solid #e6dfd8;font:12px/1.6 Arial,sans-serif;color:#8a8079">Brenda Blanche · Market Perception Strategist<br>You're receiving this because you completed the Why-Hire-You Scorecard and asked for your results.${consent ? ' You also agreed to receive follow-up emails. Reply to this email to unsubscribe.' : ''}</p>
</td></tr></table></td></tr></table></body></html>`;
}

function notifyEmail(d, name, email, gaps, scores, url, ans, seg, ready, help, question) {
  const row = (a, b) => `<tr><td style="padding:6px 14px 6px 0;color:#6b625b">${esc(a)}</td><td style="padding:6px 0"><b>${b}</b></td></tr>`;
  return `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#14100F">
<p style="font-size:18px"><b>${esc(name)}</b> just took the Why-Hire-You Scorecard.</p>
<table style="border-collapse:collapse">${row('Email', esc(email))}${row('Follow-up emails', d.consent === true ? 'YES: agreed to the sequence' : 'No: results email only')}${row('Situation they picked', esc(seg ? seg + ': ' + SEGL[seg] : '(not given)'))}${row('Could deliver this month?', esc(READYL[ready] || '(not given)'))}${row('Help they want', esc(HELPL[help] || '(not given)'))}${row('Result type', esc(t(d.result_type)))}${row('Priority area', esc(gaps.join(' + ') || 'None flagged'))}${row('Total (context only)', esc(Number(d.score) || 0) + ' / 72')}</table>
${question ? `<p style="margin:18px 0 6px"><b>The one question they most want answered (their words)</b></p><p style="margin:0;padding:12px 14px;border-left:3px solid #E4007C;background:#faf6f1">${esc(question)}</p>` : ''}
<p style="margin:18px 0 6px"><b>Six-dimension breakdown</b></p>
<table style="border-collapse:collapse">${DIMS.map((n, i) => row(n, `${scores[i]} / 12 · ${esc(band(scores[i]))}`)).join('')}</table>
${ans ? `<p style="margin:18px 0 6px"><b>Their answers, question by question</b></p>` + DIMS.map((n, di) => `<p style="margin:12px 0 4px;color:#E4007C"><b>${esc(n)}</b></p>` + [0, 1, 2].map(k => { const i = di * 3 + k; return `<p style="margin:0 0 6px"><span style="color:#6b625b">Q${i + 1} ${esc(QLABELS[i])}:</span><br>${ans[i].s}/4 · ${esc(ans[i].t)}</p>`; }).join('')).join('') : ''}
<p style="margin:18px 0 6px"><b>About them</b></p>
<table style="border-collapse:collapse">${row('Role / industry', esc(t(d.role)) || '(blank)')}${row('Primary service', esc(t(d.service)) || '(blank)')}${row('Who they want to help', esc(t(d.audience)) || '(blank)')}${row('Their question', esc(question) || '(blank)')}</table>
${url ? `<p style="margin-top:18px"><a href="${esc(url)}">Open their results page</a></p>` : ''}</div>`;
}

async function handle(request, env) {
  let d; try { d = await request.json(); } catch { return json({ ok: false }, 400); }
  if (d['bot-field']) return json({ ok: true });
  const email = t(d.email).toLowerCase(), name = t(d.name);
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) return json({ ok: false }, 400);
  const consent = d.consent === true;   // optional: only controls the follow-up emails. Their results link is always sent (they asked for it).
  const scores = [d.market_problem, d.offer_design, d.positioning, d.evidence_trust, d.signals, d.buyer_journey].map(n => Math.max(0, Math.min(12, Number(n) || 0)));
  const ans = cleanAnswers(d.answers);
  const kind = ['single', 'combined', 'strong'].includes(d.result_type) ? d.result_type : '';
  const gaps = gapNames(d.primary_gap);
  let url = ''; try { const u = new URL(String(d.results_url || '')); if (u.origin === new URL(request.url).origin) url = u.toString().slice(0, 300); } catch {}   // only links back to this site

  const seg = Object.keys(SEGL).includes(d.segment) ? d.segment : '';
  const ready = [1, 2, 3, 4].includes(Number(d.deliver)) ? Number(d.deliver) : 0;
  const help = [1, 2, 3, 4].includes(Number(d.help)) ? Number(d.help) : 0;
  const question = q600(d.question);
  const core = { FIRSTNAME: name, SCORE: Number(d.score) || 0, RESULT_TYPE: kind, CONSENT: consent, RESULTS_URL: url, PRIMARY_GAP: gaps.join(' + '), SECONDARY_GAP: gapNames(d.secondary_gap).join(' + '),
    PRIMARY_SCORE: Number(d.primary_score) || 0, SECONDARY_SCORE: Number(d.secondary_score) || 0, STRONGEST: DIMS.includes(d.strongest) ? d.strongest : '',
    MARKET_PROBLEM: scores[0], OFFER_DESIGN: scores[1], POSITIONING: scores[2], EVIDENCE_TRUST: scores[3], SIGNALS: scores[4], BUYER_JOURNEY: scores[5],
    ROLE: t(d.role), PRIMARY_SERVICE: t(d.service), AUDIENCE: t(d.audience) };
  const extra = { SEGMENT: seg, SEGMENT_LABEL: seg ? SEGL[seg] : '', READY_TO_DELIVER: READYL[ready] || '', HELP_WANTED: HELPL[help] || '', QUESTION: question };
  const answerAttrs = ans ? Object.fromEntries(QKEYS.map((k, i) => [k, `${ans[i].s}/4 · ${ans[i].t}`])) : {};
  const ids = env.BREVO_LIST_ID ? [Number(env.BREVO_LIST_ID)] : undefined;
  const saveContact = async () => {
    const tiers = [{ ...core, ...extra, ...answerAttrs }, { ...core, ...extra }, core, { FIRSTNAME: name }];   // each tier drops attributes that may not be created in Brevo yet
    let r;
    for (const attributes of tiers) { r = await brevo(env, { email, attributes, listIds: ids, updateEnabled: true }); if (r.status !== 400) break; }
    return r.ok;
  };
  const jobs = [
    env.BREVO_API_KEY ? saveContact() : Promise.resolve(false),
    env.RESEND_API_KEY && env.RESEND_FROM && env.NOTIFY_EMAIL ? resend(env, env.NOTIFY_EMAIL, `New Scorecard: ${name}${seg ? ' [' + seg + ']' : ''}${gaps.length ? ' · ' + gaps.join(' + ') : ''}`, notifyEmail(d, name, email, gaps, scores, url, ans, seg, ready, help, question), email).then(r => r.ok) : Promise.resolve(false),
    env.RESEND_API_KEY && env.RESEND_FROM && url ? resend(env, email, 'Your Why-Hire-You Scorecard results', firstEmail(name, kind, gaps, url, consent, seg), env.NOTIFY_EMAIL).then(r => r.ok) : Promise.resolve(false),
  ];
  const [contact, notified, welcomed] = (await Promise.allSettled(jobs)).map(x => x.status === 'fulfilled' && x.value);
  return (contact || notified || welcomed) ? json({ ok: true, contact, notified, welcomed }) : json({ ok: false }, 502);
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/api/scorecard') return request.method === 'POST' ? handle(request, env) : new Response('Method not allowed', { status: 405 });
    return env.ASSETS.fetch(request);
  },
};
