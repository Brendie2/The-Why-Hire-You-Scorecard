/* Scorecard worker. Serves the site and handles POST /api/scorecard.

   When someone enters their name + email (with consent) before seeing results:
     1) BREVO   saves/updates the contact: scores, primary gap, consent, results link,
                segment, delivery history, past help-seeking, story, and offer-routing path
     2) RESEND  emails Brenda: "This person took the Scorecard", with the full results
     3) RESEND  emails the person: "This is why clients hesitate to hire you"
                with their results link and, where appropriate, the Clarity Call link

   This version matches the Mom Test-based assessment (21 questions, all about past events):
     - Opener (unscored): which situation happened most in the last 3 months -> SEGMENT
     - 18 scored questions (3 per area, 1-4 each)
     - 2 bonus routing questions (unscored):
         READY_TO_DELIVER = "Have you delivered this kind of work for a paying client in the last 12 months?"
         HELP_WANTED      = "The last time you wanted help with something like this, what did you do?"
     - QUESTION now holds the story ("last time a client asked what you do") plus
       "Already tried: ..." when they filled that box in.
     - Offer routing mirrors the results page exactly.

   Brevo TEXT contact attributes (create once):
     SEGMENT, SEGMENT_LABEL, READY_TO_DELIVER, HELP_WANTED, QUESTION, OFFER_PATH
   Other attributes:
     SCORECARD_DATE - Date
     BOOKED_OR_PURCHASED - Boolean

   The Q01-Q18 attribute NAMES are unchanged on purpose, so your existing Brevo
   attributes keep working. Some names no longer describe the question exactly
   (see the map next to QKEYS). The saved values are correct.

   Variables and Secrets (Settings > Variables and Secrets):
     BREVO_API_KEY (Secret)
     BREVO_LIST_ID
     RESEND_API_KEY (Secret)
     RESEND_FROM  e.g. Brenda Blanche <hello@brendablanche.site>
     NOTIFY_EMAIL - where Brenda's notifications go
*/

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { 'Content-Type': 'application/json' }
  });

const t = v => String(v ?? '').trim().slice(0, 300);

/* Escape to real HTML entities. */
const esc = s =>
  String(s ?? '').replace(/[&<>"]/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;'
  }[c]));

const DIMS = [
  'Market & Problem Clarity',
  'Offer Design',
  'Positioning & Differentiation',
  'Evidence & Trust',
  'Market Signals & Recognition',
  'Buyer Journey & Conversion'
];

/* Attribute names kept as-is. What each one now holds:
   Q01 last 3 enquiries: who          Q10 asked last 3 clients for proof
   Q02 prospect's words               Q11 last hesitation: reason
   Q03 paid / asked price             Q12 what client saw before booking
   Q04 asked what to hire you for     Q13 headline + About + posts together
   Q05 chose 1 lead service           Q14 who commented on last 5 posts
   Q06 how last price was set         Q15 how a referrer described you
   Q07 what prospect said of profile  Q16 next 7 days after interest
   Q08 why buyer chose them/other     Q17 last 3 proposals
   Q09 last time you said why you     Q18 what you did when prospect went quiet */
const QKEYS = [
  'Q01_BUYER_TYPE',
  'Q02_BUYER_PROBLEM',
  'Q03_PROBLEM_EVIDENCE',
  'Q04_OFFER_CLARITY',
  'Q05_OFFER_COMMITMENT',
  'Q06_OFFER_PRICE',
  'Q07_POSITIONING_FIT',
  'Q08_DIFFERENTIATION',
  'Q09_CONFIDENCE',
  'Q10_ABILITY_PROOF',
  'Q11_OBJECTIONS',
  'Q12_EXPECTATIONS',
  'Q13_MESSAGE_CONSISTENCY',
  'Q14_KNOWN_FOR',
  'Q15_VISIBILITY_METHOD',
  'Q16_NEXT_STEP',
  'Q17_PATH_TO_BUYING',
  'Q18_LEARNING_LOOP'
];

const QLABELS = [
  'Who your last 3 enquiries came from',
  'The words a prospect used for their problem',
  'Whether anyone paid or asked your price',
  'What happened when asked what to hire you for',
  'What you did when choosing 1 lead service',
  'How your last price was set',
  'What a prospect said about your profile or site',
  'Why a buyer chose you or another provider',
  'What you said when explaining why you are right',
  'Whether you asked past clients for proof',
  'The reason behind the last hesitation',
  'What the last client saw before booking',
  'What your headline, About and posts say together',
  'Who responded to your last 5 posts',
  'How a referrer described what you do',
  'What happened in the 7 days after interest',
  'What happened to your last 3 proposals',
  'What you did when a prospect went quiet'
];

const cleanAnswers = raw =>
  Array.isArray(raw) && raw.length === 18
    ? raw.map(x => ({
        s: [1, 2, 3, 4].includes(Number(x?.s)) ? Number(x.s) : 0,
        t: String(x?.t ?? '').trim().slice(0, 160)
      }))
    : null;

const FRIENDLY = {
  'Market & Problem Clarity': 'Who you help',
  'Offer Design': 'What exactly you sell',
  'Positioning & Differentiation': 'Why they should pick you',
  'Evidence & Trust': 'Why they can trust you',
  'Market Signals & Recognition': 'What people see online',
  'Buyer Journey & Conversion': 'What happens after they’re interested'
};

/* Same wording as the options on the assessment's first question. */
const SEGL = {
  A: 'People asked what I do, and I struggled to say what they could hire me for.',
  B: 'I had several things I could offer and couldn’t decide which to lead with.',
  C: 'I have real experience, but someone with less of it won work I was right for.',
  D: 'I kept posting or networking and got reactions, but no real enquiries.',
  E: 'Prospects showed interest, then went quiet or said it was too expensive.',
  X: 'None of these, or a mix.'
};

/* Bonus question 1: delivered this kind of work for a paying client in the last 12 months? */
const READYL = {
  1: 'Yes, for paying clients, more than once',
  2: 'Yes, but not recently or only as a small part of a bigger project',
  3: 'Not as a paid engagement yet (has the skills, no client has paid for this)',
  4: 'No, still building the skill'
};

/* Bonus question 2: the last time they wanted help with something like this, what did they do? */
const HELPL = {
  1: 'Worked on it themselves',
  2: 'Talked it through with 1 person (peer, mentor or call)',
  3: 'Paid for guided help (coach, course or consultant)',
  4: 'Has not tried anything yet'
};

const q1100 = v => String(v ?? '').trim().slice(0, 1100);

const fr = n => FRIENDLY[n] || n;

const band = s =>
  s >= 10
    ? 'Stronger foundation'
    : s >= 7
      ? 'Inconsistent or incomplete'
      : 'Priority to investigate';

const gapNames = v =>
  String(v || '')
    .split(' + ')
    .filter(x => DIMS.includes(x));

/* Brevo offer-routing path. Mirrors the "Suggested for you" logic on the results page:

   1. Still building the skill (ready = 4)  -> no_pitch (page shows no call or program)
   2. Worked on it themselves (help = 1)    -> self_guided
   3. Talked to 1 person (help = 2)         -> clarity_call
   4. Paid for guided help (help = 3)       -> blueprint
   5. Hasn't tried anything (help = 4)      -> self_guided if no area is a priority, else clarity_call

   Note: ready = 3 (no paid engagement yet) is NOT blocked, because the page still
   shows the offers to those people, with a note that first proof matters more. */
const offerPath = (resultType, ready, help) => {
  if (ready === 4) return 'no_pitch';
  if (help === 1) return 'self_guided';
  if (help === 2) return 'clarity_call';
  if (help === 3) return 'blueprint';
  return resultType === 'strong' ? 'self_guided' : 'clarity_call';
};

const brevo = (env, body) =>
  fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers: {
      'api-key': env.BREVO_API_KEY,
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify(body)
  });

const resend = (env, to, subject, html, replyTo) =>
  fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.RESEND_API_KEY,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      from: env.RESEND_FROM,
      to: [to],
      subject,
      html,
      ...(replyTo ? { reply_to: replyTo } : {})
    })
  });

const P =
  'margin:0 0 18px;font:17px/1.65 Georgia,\'Times New Roman\',serif;color:#14100F';

const CLARITY_CALL_URL = 'https://clarity.brendablanche.site';

function firstEmail(name, kind, gaps, url, consent, seg, path) {
  const g = gaps.map(fr).join(' + ');

  const line =
    kind === 'single' && g
      ? `Your lowest-scoring area was <b>${esc(g)}</b>. That is where your answers suggest it may be worth looking first.`
      : kind === 'combined' && g
        ? `More than one area scored equally low: <b>${esc(g)}</b>. Your answers suggest the gap may not sit in just one place.`
        : kind === 'strong'
          ? 'None of your six areas scored in the lower bands. Your results page explains how to check whether your market-facing evidence supports that.'
          : '';

  const resultsButton = `
    <p style="margin:6px 0 24px">
      <a href="${esc(url)}"
         style="display:inline-block;background:#E4007C;color:#ffffff;text-decoration:none;font:600 15px Arial,sans-serif;letter-spacing:.04em;padding:14px 26px;border-radius:999px">
        VIEW MY RESULTS
      </a>
    </p>`;

  const callButton = `
    <p style="margin:6px 0 24px">
      <a href="${CLARITY_CALL_URL}"
         style="display:inline-block;background:#14100F;color:#ffffff;text-decoration:none;font:600 15px Arial,sans-serif;letter-spacing:.04em;padding:14px 26px;border-radius:999px">
        BOOK MY 27-MINUTE CLARITY CALL
      </a>
    </p>`;

  const showCall = path !== 'no_pitch';

  return `<!DOCTYPE html>
<html>
  <body style="margin:0;background:#ffffff">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0">
      Here is where qualified buyers get confused.
    </div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td align="center" style="padding:28px 16px">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">
            <tr>
              <td>
                <p style="${P}">Hi ${esc(name)},</p>

                <p style="${P}">
                  Your <b>Why-Hire-You Scorecard</b> results are ready.
                </p>

                <p style="${P}">
                  Your result does not measure whether you are good at your work.
                </p>

                <p style="${P}">
                  It measures something more commercial:
                </p>

                <p style="${P}">
                  <b>Can a potential client quickly understand, trust, and choose you?</b>
                </p>

                ${
                  seg && seg !== 'X'
                    ? `<p style="${P}">You told us this happened most often in the last 3 months:</p>
                       <p style="${P}"><i>&ldquo;${esc(SEGL[seg])}&rdquo;</i></p>`
                    : ''
                }

                ${line ? `<p style="${P}">${line}</p>` : ''}

                <p style="${P}">
                  That matters because buyers cannot say yes confidently if they cannot quickly answer:
                </p>

                <ul style="margin:0 0 18px;padding-left:22px;font:17px/1.65 Georgia,serif;color:#14100F">
                  <li>What problem do you solve?</li>
                  <li>Who do you solve it for?</li>
                  <li>Why should they choose you instead of another consultant?</li>
                </ul>

                <p style="${P}">
                  Your answers point to where that understanding may be breaking down.
                </p>

                <p style="${P}">
                  Start by reviewing your full breakdown here:
                </p>

                ${resultsButton}

                <p style="${P}">
                  Here is one question to sit with as you read it:
                </p>

                <p style="${P}">
                  <b>What would a stranger need to understand, believe, or see before they felt safe saying yes to me?</b>
                </p>

                <p style="${P}">
                  Write your answer down. Then compare it with what your profile, posts, offer, and proof currently say.
                </p>

                <p style="${P}">
                  You may notice a gap worth fixing.
                </p>

                ${
                  consent
                    ? `<p style="${P}">Over the next few days, I’ll share practical ways to look at that gap—without assuming you need to post more, redesign everything, or change your whole business.</p>`
                    : ''
                }

                ${
                  showCall
                    ? `<p style="${P}">If you want help interpreting your result and identifying your fastest next move, book a <b>27-minute Why-Hire-You Clarity Call</b>.</p>
                       ${callButton}`
                    : `<p style="${P}">When you’re ready, your results page also shows practical next steps for where you are right now.</p>`
                }

                <p style="${P}">Talk soon,<br>Brenda</p>

                <p style="margin:0;padding-top:18px;border-top:1px solid #e6dfd8;font:12px/1.6 Arial,sans-serif;color:#8a8079">
                  Brenda Blanche &middot; Market Perception Strategist<br>
                  You’re receiving this because you completed the Why-Hire-You Scorecard and asked for your results.${
                    consent
                      ? ' You also agreed to receive follow-up emails. Reply to this email to unsubscribe.'
                      : ''
                  }
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function notifyEmail(
  d,
  name,
  email,
  gaps,
  scores,
  url,
  ans,
  seg,
  ready,
  help,
  question,
  path
) {
  const row = (a, b) =>
    `<tr>
      <td style="padding:6px 14px 6px 0;color:#6b625b">${esc(a)}</td>
      <td style="padding:6px 0"><b>${b}</b></td>
    </tr>`;

  /* The form combines the story and the "already tried" box into one field. */
  const [story, tried] = question.split('\n\nAlready tried: ');

  /* Same measure the results page shows: answers that describe something that happened (3 or 4 pts). */
  const events = ans ? ans.filter(a => a.s >= 3).length : null;

  const quote = txt =>
    `<p style="margin:0 0 10px;padding:12px 14px;border-left:3px solid #E4007C;background:#faf6f1;white-space:pre-wrap">${esc(txt)}</p>`;

  return `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#14100F">
    <p style="font-size:18px"><b>${esc(name)}</b> just took the Why-Hire-You Scorecard.</p>

    <table style="border-collapse:collapse">
      ${row('Email', esc(email))}
      ${row(
        'Follow-up emails',
        d.consent === true
          ? 'YES: agreed to the sequence'
          : 'No: results email only'
      )}
      ${row(
        'Happened most in last 3 months',
        esc(seg ? seg + ': ' + SEGL[seg] : '(not given)')
      )}
      ${row(
        'Delivered this for a paying client (12 months)',
        esc(READYL[ready] || '(not given)')
      )}
      ${row(
        'Last time they wanted help, they',
        esc(HELPL[help] || '(not given)')
      )}
      ${row('Result type', esc(t(d.result_type)))}
      ${row('Priority area', esc(gaps.join(' + ') || 'None flagged'))}
      ${row('Offer path (Brevo)', esc(path))}
      ${row('Total (context only)', esc(Number(d.score) || 0) + ' / 72')}
      ${
        events === null
          ? ''
          : row('Answers based on real events', esc(events) + ' / 18')
      }
    </table>

    ${
      story
        ? `<p style="margin:18px 0 6px"><b>The last time a potential client asked what they do (their words)</b></p>${quote(story)}`
        : ''
    }
    ${
      tried
        ? `<p style="margin:12px 0 6px"><b>What they have already tried or paid for (their words)</b></p>${quote(tried)}`
        : ''
    }

    <p style="margin:18px 0 6px"><b>Six-dimension breakdown</b></p>
    <table style="border-collapse:collapse">
      ${DIMS.map(
        (n, i) => row(n, `${scores[i]} / 12 &middot; ${esc(band(scores[i]))}`)
      ).join('')}
    </table>

    ${
      ans
        ? `<p style="margin:18px 0 6px"><b>Their answers, question by question</b></p>` +
          DIMS.map(
            (n, di) =>
              `<p style="margin:12px 0 4px;color:#E4007C"><b>${esc(n)}</b></p>` +
              [0, 1, 2]
                .map(k => {
                  const i = di * 3 + k;
                  return `<p style="margin:0 0 6px"><span style="color:#6b625b">Q${i + 1} ${esc(
                    QLABELS[i]
                  )}:</span><br>${ans[i].s}/4 &middot; ${esc(ans[i].t)}</p>`;
                })
                .join('')
          ).join('')
        : ''
    }

    <p style="margin:18px 0 6px"><b>About them</b></p>
    <table style="border-collapse:collapse">
      ${row('Role / industry', esc(t(d.role)) || '(blank)')}
      ${row('What a client would hire them for', esc(t(d.service)) || '(blank)')}
      ${row('Their last best client', esc(t(d.audience)) || '(blank)')}
    </table>

    ${url ? `<p style="margin-top:18px"><a href="${esc(url)}">Open their results page</a></p>` : ''}
  </div>`;
}

async function handle(request, env) {
  let d;

  try {
    d = await request.json();
  } catch {
    return json({ ok: false }, 400);
  }

  if (d['bot-field']) return json({ ok: true });

  const email = t(d.email).toLowerCase();
  const name = t(d.name);

  if (!name || !/^\S+@\S+@\S+$/.test(email) === false && !/^\S+@\S+\.\S+$/.test(email)) {
    return json({ ok: false }, 400);
  }

  const consent = d.consent === true;

  const scores = [
    d.market_problem,
    d.offer_design,
    d.positioning,
    d.evidence_trust,
    d.signals,
    d.buyer_journey
  ].map(n => Math.max(0, Math.min(12, Number(n) || 0)));

  const ans = cleanAnswers(d.answers);
  const kind = ['single', 'combined', 'strong'].includes(d.result_type)
    ? d.result_type
    : '';

  const gaps = gapNames(d.primary_gap);

  let url = '';

  try {
    const u = new URL(String(d.results_url || ''));

    if (u.origin === new URL(request.url).origin) {
      url = u.toString().slice(0, 300);
    }
  } catch {}

  const seg = Object.keys(SEGL).includes(d.segment) ? d.segment : '';
  const ready = [1, 2, 3, 4].includes(Number(d.deliver)) ? Number(d.deliver) : 0;
  const help = [1, 2, 3, 4].includes(Number(d.help)) ? Number(d.help) : 0;

  /* Story (up to 600) + "Already tried" (up to 400) arrive together, so allow room for both. */
  const question = q1100(d.question);

  const path = offerPath(kind, ready, help);
  const today = new Date().toISOString().slice(0, 10);

  const core = {
    FIRSTNAME: name,
    SCORE: Number(d.score) || 0,
    RESULT_TYPE: kind,
    CONSENT: consent,
    RESULTS_URL: url,
    PRIMARY_GAP: gaps.join(' + '),
    SECONDARY_GAP: gapNames(d.secondary_gap).join(' + '),
    PRIMARY_SCORE: Number(d.primary_score) || 0,
    SECONDARY_SCORE: Number(d.secondary_score) || 0,
    STRONGEST: DIMS.includes(d.strongest) ? d.strongest : '',
    MARKET_PROBLEM: scores[0],
    OFFER_DESIGN: scores[1],
    POSITIONING: scores[2],
    EVIDENCE_TRUST: scores[3],
    SIGNALS: scores[4],
    BUYER_JOURNEY: scores[5],
    ROLE: t(d.role),
    PRIMARY_SERVICE: t(d.service),
    AUDIENCE: t(d.audience),
    OFFER_PATH: path,
    SCORECARD_DATE: today,
    BOOKED_OR_PURCHASED: false
  };

  const extra = {
    SEGMENT: seg,
    SEGMENT_LABEL: seg ? SEGL[seg] : '',
    READY_TO_DELIVER: READYL[ready] || '',
    HELP_WANTED: HELPL[help] || '',
    QUESTION: question
  };

  const answerAttrs = ans
    ? Object.fromEntries(
        QKEYS.map((k, i) => [k, `${ans[i].s}/4 \u00B7 ${ans[i].t}`])
      )
    : {};

  const ids = env.BREVO_LIST_ID ? [Number(env.BREVO_LIST_ID)] : undefined;

  const saveContact = async () => {
    const tiers = [
      { ...core, ...extra, ...answerAttrs },
      { ...core, ...extra },
      core,
      { FIRSTNAME: name }
    ];

    let r;

    for (const attributes of tiers) {
      r = await brevo(env, {
        email,
        attributes,
        listIds: ids,
        updateEnabled: true
      });

      if (r.status !== 400) break;
    }

    return r.ok;
  };

  const jobs = [
    env.BREVO_API_KEY ? saveContact() : Promise.resolve(false),

    env.RESEND_API_KEY && env.RESEND_FROM && env.NOTIFY_EMAIL
      ? resend(
          env,
          env.NOTIFY_EMAIL,
          `New Scorecard: ${name}${seg ? ' [' + seg + ']' : ''}${
            gaps.length ? ' \u00B7 ' + gaps.join(' + ') : ''
          }`,
          notifyEmail(
            d,
            name,
            email,
            gaps,
            scores,
            url,
            ans,
            seg,
            ready,
            help,
            question,
            path
          ),
          email
        ).then(r => r.ok)
      : Promise.resolve(false),

    env.RESEND_API_KEY && env.RESEND_FROM && url
      ? resend(
          env,
          email,
          name
            ? `This is why clients hesitate to hire you, ${name}`
            : 'This is why clients hesitate to hire you',
          firstEmail(name, kind, gaps, url, consent, seg, path),
          env.NOTIFY_EMAIL
        ).then(r => r.ok)
      : Promise.resolve(false)
  ];

  const [contact, notified, welcomed] = (await Promise.allSettled(jobs)).map(
    x => x.status === 'fulfilled' && x.value
  );

  return (contact || notified || welcomed)
    ? json({ ok: true, contact, notified, welcomed })
    : json({ ok: false }, 502);
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/api/scorecard') {
      return request.method === 'POST'
        ? handle(request, env)
        : new Response('Method not allowed', { status: 405 });
    }

    return env.ASSETS.fetch(request);
  }
};
