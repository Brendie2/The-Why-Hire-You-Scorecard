/* Scorecard worker. Serves the site and handles POST /api/scorecard.
   When someone enters their name + email (with consent) before seeing results:
     1) BREVO   saves/updates the contact (the "table"): scores, primary gap, consent, results link
     2) RESEND  emails Brenda: "This person took the Scorecard", with the full results
     3) RESEND  emails the person: "Your results are in" with their results link
   Variables and Secrets (Settings > Variables and Secrets):
     BREVO_API_KEY (Secret) · BREVO_LIST_ID
     RESEND_API_KEY (Secret) · RESEND_FROM  e.g.  Brenda Blanche <hello@brendablanche.site>
     NOTIFY_EMAIL           where Brenda's notifications go                                          */

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
const t = v => String(v ?? '').trim().slice(0, 300);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const DIMS = ['Market & Problem Clarity', 'Offer Design', 'Positioning & Differentiation', 'Evidence & Trust', 'Market Signals & Recognition', 'Buyer Journey & Conversion'];
const QKEYS = ['Q01_BUYER_TYPE', 'Q02_BUYER_PROBLEM', 'Q03_PROBLEM_EVIDENCE', 'Q04_OFFER_CLARITY', 'Q05_OFFER_OUTCOME', 'Q06_OFFER_DEMAND', 'Q07_POSITIONING_FIT', 'Q08_DIFFERENTIATION', 'Q09_ASSOCIATION',
  'Q10_ABILITY_PROOF', 'Q11_OBJECTIONS', 'Q12_EXPECTATIONS', 'Q13_MESSAGE_CONSISTENCY', 'Q14_KNOWN_FOR', 'Q15_VISIBILITY_METHOD', 'Q16_NEXT_STEP', 'Q17_PATH_TO_BUYING', 'Q18_LEARNING_LOOP'];
const QLABELS = ['Who needs your expertise', 'The buyer\'s problem in their words', 'Evidence the problem matters', 'Can a buyer say what to hire you for', 'Link to a buyer outcome', 'Offer addresses a problem buyers will pay for',
  'Why your work matters (quick read)', 'What makes your approach different', 'What you want to be associated with', 'What a buyer can see of your ability', 'Handling buyer hesitations', 'What working with you involves',
  'Consistency across profile, offer, content', 'Would a follower know what you\'re known for', 'Deliberate way to make value visible', 'Is the next step clear', 'Path from discovery to considering you', 'Learning from buyer questions and decisions'];
const cleanAnswers = raw => Array.isArray(raw) && raw.length === 18 ? raw.map(x => ({ s: [1, 2, 3, 4].includes(Number(x?.s)) ? Number(x.s) : 0, t: String(x?.t ?? '').trim().slice(0, 160) })) : null;
const FRIENDLY = { 'Market & Problem Clarity': 'Knowing who you help', 'Offer Design': 'Turning your skills into a service people can buy', 'Positioning & Differentiation': 'Giving people a reason to choose you', 'Evidence & Trust': 'Showing people they can trust your work', 'Market Signals & Recognition': 'Helping the right people notice and remember you', 'Buyer Journey & Conversion': 'Making it easier for people to take the next step' };
const fr = n => FRIENDLY[n] || n;
const band = s => s >= 10 ? 'Stronger foundation' : s >= 7 ? 'Inconsistent or incomplete' : 'Priority to investigate';
const gapNames = v => String(v || '').split(' + ').filter(x => DIMS.includes(x));   // only known dimension names are ever put in an email

const brevo = (env, body) => fetch('https://api.brevo.com/v3/contacts', { method: 'POST',
  headers: { 'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
const resend = (env, to, subject, html, replyTo) => fetch('https://api.resend.com/emails', { method: 'POST',
  headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' },
  body: JSON.stringify({ from: env.RESEND_FROM, to: [to], subject, html, ...(replyTo ? { reply_to: replyTo } : {}) }) });

const P = 'margin:0 0 18px;font:17px/1.65 Georgia,\'Times New Roman\',serif;color:#14100F';
function firstEmail(name, kind, gaps, url, consent) {
  const g = gaps.map(fr).join(' + ');
  const line = kind === 'single' && g ? `Your lowest-scoring area was <b>${esc(g)}</b>. That is where your answers suggest it may be worth looking first.`
    : kind === 'combined' && g ? `More than one area scored equally low: <b>${esc(g)}</b>. Your answers suggest the gap may not sit in just one place.`
    : kind === 'strong' ? 'None of your six areas scored in the lower bands. Your results page explains how to check whether your market-facing evidence supports that.' : '';
  const btn = l => `<p style="margin:6px 0 24px"><a href="${esc(url)}" style="display:inline-block;background:#E4007C;color:#ffffff;text-decoration:none;font:600 15px Arial,sans-serif;letter-spacing:.04em;padding:14px 26px;border-radius:999px">${l}</a></p>`;
  return `<!DOCTYPE html><html><body style="margin:0;background:#ffffff"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 16px"><table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%"><tr><td>
<p style="${P}">Hi ${esc(name)},</p><p style="${P}">Your Why-Hire-You Scorecard results are ready.</p>${btn('VIEW YOUR RESULTS')}
<p style="${P}">Your answers look at six areas that affect how people understand, trust, and consider your services:</p>
<ul style="margin:0 0 18px;padding-left:22px;font:17px/1.65 Georgia,serif;color:#14100F">${DIMS.map(d => `<li>${esc(fr(d))}</li>`).join('')}</ul>
<p style="${P}">As you review your breakdown, pay attention to the area or areas that scored lowest.</p>
${line ? `<p style="${P}">${line}</p>` : ''}
<p style="${P}">That can give you a useful starting point—but it isn't proof of the underlying problem. Your answers tell us where to investigate, not exactly what every potential buyer thinks.</p>
<p style="${P}">Here's one exercise to begin with:</p><p style="${P}">Ask yourself: What would a relevant buyer need to understand, believe, or see before feeling comfortable taking the next step with me?</p>
<p style="${P}">Write down your answer. Then compare it with what your current offer, profile, content, and evidence actually communicate.</p><p style="${P}">You may notice a gap worth addressing.</p>
<p style="${P}">${consent ? `Over the next few days, I'll share some practical ways to examine that gap without immediately assuming you need to post more, redesign everything, or change your entire business.` : `When you're ready, your results page also shows some practical next steps, including how to book a Clarity Call or message me on WhatsApp.`}</p>
<p style="${P}">Start with your results here:</p>${btn('VIEW MY RESULTS')}<p style="${P}">Brenda</p>
<p style="margin:0;padding-top:18px;border-top:1px solid #e6dfd8;font:12px/1.6 Arial,sans-serif;color:#8a8079">Brenda Blanche · Market Perception Strategist<br>You're receiving this because you completed the Why-Hire-You Scorecard and asked for your results.${consent ? ' You also agreed to receive follow-up emails. Reply to this email to unsubscribe.' : ''}</p>
</td></tr></table></td></tr></table></body></html>`;
}

function notifyEmail(d, name, email, gaps, scores, url, ans) {
  const row = (a, b) => `<tr><td style="padding:6px 14px 6px 0;color:#6b625b">${esc(a)}</td><td style="padding:6px 0"><b>${b}</b></td></tr>`;
  return `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#14100F">
<p style="font-size:18px"><b>${esc(name)}</b> just took the Why-Hire-You Scorecard.</p>
<table style="border-collapse:collapse">${row('Email', esc(email))}${row('Follow-up emails', d.consent === true ? 'YES: agreed to the sequence' : 'No: results email only')}${row('Result type', esc(t(d.result_type)))}${row('Priority area', esc(gaps.join(' + ') || 'None flagged'))}${row('Total (context only)', esc(Number(d.score) || 0) + ' / 72')}</table>
<p style="margin:18px 0 6px"><b>Six-dimension breakdown</b></p>
<table style="border-collapse:collapse">${DIMS.map((n, i) => row(n, `${scores[i]} / 12 · ${esc(band(scores[i]))}`)).join('')}</table>
${ans ? `<p style="margin:18px 0 6px"><b>Their answers, question by question</b></p>` + DIMS.map((n, di) => `<p style="margin:12px 0 4px;color:#E4007C"><b>${esc(n)}</b></p>` + [0, 1, 2].map(k => { const i = di * 3 + k; return `<p style="margin:0 0 6px"><span style="color:#6b625b">Q${i + 1} ${esc(QLABELS[i])}:</span><br>${ans[i].s}/4 · ${esc(ans[i].t)}</p>`; }).join('')).join('') : ''}
<p style="margin:18px 0 6px"><b>About them</b></p>
<table style="border-collapse:collapse">${row('Role / industry', esc(t(d.role)) || '(blank)')}${row('Primary service', esc(t(d.service)) || '(blank)')}${row('Who they want to help', esc(t(d.audience)) || '(blank)')}${row('Biggest struggle', esc(t(d.struggle)) || '(blank)')}</table>
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

  const full = { FIRSTNAME: name, SCORE: Number(d.score) || 0, RESULT_TYPE: kind, CONSENT: consent, RESULTS_URL: url, PRIMARY_GAP: gaps.join(' + '), SECONDARY_GAP: gapNames(d.secondary_gap).join(' + '),
    PRIMARY_SCORE: Number(d.primary_score) || 0, SECONDARY_SCORE: Number(d.secondary_score) || 0, STRONGEST: DIMS.includes(d.strongest) ? d.strongest : '',
    MARKET_PROBLEM: scores[0], OFFER_DESIGN: scores[1], POSITIONING: scores[2], EVIDENCE_TRUST: scores[3], SIGNALS: scores[4], BUYER_JOURNEY: scores[5],
    ROLE: t(d.role), PRIMARY_SERVICE: t(d.service), AUDIENCE: t(d.audience), STRUGGLE: t(d.struggle) };
  const answerAttrs = ans ? Object.fromEntries(QKEYS.map((k, i) => [k, `${ans[i].s}/4 · ${ans[i].t}`])) : {};
  const ids = env.BREVO_LIST_ID ? [Number(env.BREVO_LIST_ID)] : undefined;
  const saveContact = async () => {
    let r = await brevo(env, { email, attributes: { ...full, ...answerAttrs }, listIds: ids, updateEnabled: true });
    if (r.status === 400) r = await brevo(env, { email, attributes: full, listIds: ids, updateEnabled: true });                 // answer attributes not created yet
    if (r.status === 400) r = await brevo(env, { email, attributes: { FIRSTNAME: name }, listIds: ids, updateEnabled: true });   // no attributes created yet
    return r.ok;
  };
  const jobs = [
    env.BREVO_API_KEY ? saveContact() : Promise.resolve(false),
    env.RESEND_API_KEY && env.RESEND_FROM && env.NOTIFY_EMAIL ? resend(env, env.NOTIFY_EMAIL, `New Scorecard: ${name}${gaps.length ? ' · ' + gaps.join(' + ') : ''}`, notifyEmail(d, name, email, gaps, scores, url, ans), email).then(r => r.ok) : Promise.resolve(false),
    env.RESEND_API_KEY && env.RESEND_FROM && url ? resend(env, email, 'Your Why-Hire-You Scorecard results', firstEmail(name, kind, gaps, url, consent), env.NOTIFY_EMAIL).then(r => r.ok) : Promise.resolve(false),
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
