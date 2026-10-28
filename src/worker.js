/*
  Why-Hire-You Scorecard worker

  Serves the site and handles POST /api/scorecard.

  On a valid scorecard submission:
    1. Saves/updates the contact in Brevo.
    2. Sends Brenda a detailed notification through Resend.
    3. Sends the participant their branded results email through Resend.

  Email 1:
    - Subject: "[First name], your results show where to look first"
    - Fuchsia hero, cream background, white reading area.
    - Results link is the primary CTA.
    - Build invitation appears only with follow-up consent
      and when OFFER_PATH is not "no_pitch".
    - No Clarity Call promotion.
    - No separate Blueprint offer.
    - No guarantee wording.

  Existing offer-routing labels are preserved for compatibility:
    no_pitch, self_guided, clarity_call, blueprint.

  Important:
    - These labels do not determine full Build eligibility.
    - Update the results page and Brevo branches together
      when changing those labels.
    - BOOKED_OR_PURCHASED is not reset on scorecard submissions.
    - Brevo follow-up automation must require current consent
      and exclude booked/purchased contacts.

  Required Cloudflare bindings / secrets:
    ASSETS
    BREVO_API_KEY
    BREVO_LIST_ID
    RESEND_API_KEY
    RESEND_FROM
    NOTIFY_EMAIL

  Brevo attributes used:
    FIRSTNAME
    SCORE
    RESULT_TYPE
    CONSENT
    RESULTS_URL
    PRIMARY_GAP
    SECONDARY_GAP
    PRIMARY_SCORE
    SECONDARY_SCORE
    STRONGEST
    MARKET_PROBLEM
    OFFER_DESIGN
    POSITIONING
    EVIDENCE_TRUST
    SIGNALS
    BUYER_JOURNEY
    ROLE
    PRIMARY_SERVICE
    AUDIENCE
    OFFER_PATH
    SCORECARD_DATE
    SEGMENT
    SEGMENT_LABEL
    READY_TO_DELIVER
    HELP_WANTED
    QUESTION
    Q01 through Q18 attributes listed below

  BOOKED_OR_PURCHASED should be maintained by your booking
  or payment process, not by this results submission.
*/

const BUILD_URL = 'https://blueprint.brendablanche.site';

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: {
      'Content-Type': 'application/json'
    }
  });

const t = v => String(v ?? '').trim().slice(0, 300);

const q1100 = v => String(v ?? '').trim().slice(0, 1100);

const esc = s =>
  String(s ?? '').replace(/[&<>"]/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;'
  }[c]));

const firstNameOf = name =>
  String(name || '').trim().split(/\s+/)[0] || 'there';

const DIMS = [
  'Market & Problem Clarity',
  'Offer Design',
  'Positioning & Differentiation',
  'Evidence & Trust',
  'Market Signals & Recognition',
  'Buyer Journey & Conversion'
];

/*
  Attribute names kept unchanged.

  Q01 last 3 enquiries: who
  Q02 prospect's words
  Q03 paid / asked price
  Q04 asked what to hire you for
  Q05 chose 1 lead service
  Q06 how last price was set
  Q07 what prospect said of profile
  Q08 why buyer chose them / another provider
  Q09 last time they explained why choose them
  Q10 asked last 3 clients for proof
  Q11 last hesitation: reason
  Q12 what client saw before booking
  Q13 headline + About + posts together
  Q14 who commented on last 5 posts
  Q15 how a referrer described them
  Q16 next 7 days after interest
  Q17 last 3 proposals
  Q18 what they did when a prospect went quiet
*/

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

const FRIENDLY = {
  'Market & Problem Clarity': 'Who you help',
  'Offer Design': 'What exactly you sell',
  'Positioning & Differentiation': 'Why they should pick you',
  'Evidence & Trust': 'Why they can trust you',
  'Market Signals & Recognition': 'What people see online',
  'Buyer Journey & Conversion': 'What happens after they’re interested'
};

const SEGL = {
  A: 'People asked what I do, and I struggled to say what they could hire me for.',
  B: 'I had several things I could offer and couldn’t decide which to lead with.',
  C: 'I have real experience, but someone with less of it won work I was right for.',
  D: 'I kept posting or networking and got reactions, but no real enquiries.',
  E: 'Prospects showed interest, then went quiet or said it was too expensive.',
  X: 'None of these, or a mix.'
};

const READYL = {
  1: 'Yes, for paying clients, more than once',
  2: 'Yes, but not recently or only as a small part of a bigger project',
  3: 'Not as a paid engagement yet (has the skills, no client has paid for this)',
  4: 'No, still building the skill'
};

const HELPL = {
  1: 'Worked on it themselves',
  2: 'Talked it through with 1 person (peer, mentor or call)',
  3: 'Paid for guided help (coach, course or consultant)',
  4: 'Has not tried anything yet'
};

const fr = name => FRIENDLY[name] || name;

const band = score =>
  score >= 10
    ? 'Stronger foundation'
    : score >= 7
      ? 'Inconsistent or incomplete'
      : 'Priority to investigate';

const gapNames = value =>
  String(value || '')
    .split(' + ')
    .filter(name => DIMS.includes(name));

const cleanAnswers = raw =>
  Array.isArray(raw) && raw.length === 18
    ? raw.map(answer => ({
        s: [1, 2, 3, 4].includes(Number(answer?.s))
          ? Number(answer.s)
          : 0,
        t: String(answer?.t ?? '').trim().slice(0, 160)
      }))
    : null;

const boundedScore = value => {
  const number = Number(value);

  return Number.isFinite(number)
    ? Math.max(0, Math.min(12, number))
    : 0;
};

const finiteNumber = value => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

/*
  Compatibility routing: unchanged from the existing worker.

  ready = 4 -> no_pitch
  help = 1  -> self_guided
  help = 2  -> clarity_call
  help = 3  -> blueprint
  otherwise -> based on result type

  Participant Email 1 only uses "no_pitch" to suppress
  the Build invitation. It does not promote the old offers.
*/

const offerPath = (resultType, ready, help) => {
  if (ready === 4) return 'no_pitch';
  if (help === 1) return 'self_guided';
  if (help === 2) return 'clarity_call';
  if (help === 3) return 'blueprint';

  return resultType === 'strong'
    ? 'self_guided'
    : 'clarity_call';
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

const resend = (
  env,
  to,
  subject,
  html,
  replyTo,
  text
) =>
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
      ...(text ? { text } : {}),
      ...(replyTo ? { reply_to: replyTo } : {})
    })
  });

/* Participant Email 1: plain-text alternative. */

function firstEmailText(
  name,
  kind,
  gaps,
  url,
  consent,
  seg,
  path
) {
  const firstName = firstNameOf(name);
  const gapLabel = gaps.map(fr).join(' + ');

  const resultLine =
    kind === 'strong'
      ? 'None of your six areas fell into the lower bands. That is a useful starting point, not a claim about what every buyer sees.'
      : kind === 'combined' && gapLabel
        ? `More than one area scored equally low: ${gapLabel}. Your answers suggest there may be more than one place to investigate.`
        : gapLabel
          ? `One area worth investigating first is ${gapLabel}. Your answers point us there; recent buyer evidence will help us understand what needs changing.`
          : 'Your results show where to investigate first. Recent buyer evidence will help us understand what needs changing.';

  const lines = [
    `Hi ${firstName},`,
    '',
    'Your Why-Hire-You Scorecard results are ready.',
    '',
    'Inside, you’ll find your breakdown across all six areas, where to investigate first, and practical next steps based on your answers.',
    '',
    `VIEW MY RESULTS: ${url}`,
    ''
  ];

  if (seg && seg !== 'X' && SEGL[seg]) {
    lines.push(
      'What you told me:',
      `"${SEGL[seg]}"`,
      ''
    );
  }

  lines.push(
    resultLine,
    '',
    'Before you rewrite anything, check what actually happened.',
    '',
    'Think of your last three genuine opportunities: an enquiry, a referral, a proposal or a serious conversation about your work.',
    '',
    'For each one, write down:',
    '- Where the person came from.',
    '- The problem they described, in their own words.',
    '- What they asked you about.',
    '- What happened next.',
    '',
    'If you do not know why someone went quiet, write "unknown". A missing answer is more useful than a confident guess.',
    '',
    'This gives you something to compare with your scorecard: do your recent opportunities point to the same area, or suggest a different question to investigate?',
    ''
  );

  if (consent && path !== 'no_pitch') {
    lines.push(
      'Map it. Position it. Express it.',
      '',
      'That is the approach behind the Build: investigate what the market is showing us, define your position and service, then express them through your LinkedIn profile, posts and message openers.',
      '',
      'If you want help turning the evidence into something concrete—not just another list of things to fix—you can explore the Build here.',
      '',
      `See how the Build works: ${BUILD_URL}`,
      ''
    );
  }

  if (consent) {
    lines.push(
      'In the next email, I’ll show you how to look for patterns in your recent opportunities before deciding what to change.',
      ''
    );
  }

  lines.push(
    'Brenda',
    'Market Perception Strategist',
    '',
    'You are receiving this email because you completed the Why-Hire-You Scorecard and requested your results.'
  );

  if (consent) {
    lines.push(
      'You also opted in to practical follow-up emails. You can unsubscribe using the link in those follow-up emails.'
    );
  }

  return lines.join('\n');
}

/* Participant Email 1: branded HTML. */

function firstEmail(name, kind, gaps, url, consent, seg, path) {
  const firstName = firstNameOf(name);
  const gapLabel = gaps.map(fr).join(' + ');

  const resultLine =
    kind === 'strong'
      ? 'None of your six areas fell into the lower bands. That is a useful starting point, not a claim about what every buyer sees.'
      : kind === 'combined' && gapLabel
        ? `More than one area scored equally low: <strong>${esc(gapLabel)}</strong>. Your answers suggest there may be more than one place to investigate.`
        : gapLabel
          ? `One area worth investigating first is <strong>${esc(gapLabel)}</strong>. Your answers point us there; recent buyer evidence will help us understand what needs changing.`
          : 'Your results show where to investigate first. Recent buyer evidence will help us understand what needs changing.';

  const situation =
    seg && seg !== 'X' && SEGL[seg]
      ? `
        <p style="margin:0 0 10px;font:700 11px/1.5 Arial,Helvetica,sans-serif;color:#C00068;letter-spacing:.12em;text-transform:uppercase;">
          What you told me
        </p>
        <p style="margin:0 0 18px;font:400 16px/1.65 Georgia,'Times New Roman',serif;color:#14100F;">
          &ldquo;${esc(SEGL[seg])}&rdquo;
        </p>`
      : '';

  const buildSection =
    consent && path !== 'no_pitch'
      ? `
        <tr>
          <td style="padding:0 24px 28px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#E4007C;">
              <tr>
                <td style="padding:20px 18px;">
                  <p style="margin:0 0 10px;font:700 11px/1.5 Arial,Helvetica,sans-serif;color:#FFFFFF;letter-spacing:.12em;text-transform:uppercase;">
                    Map it. Position it. Express it.
                  </p>
                  <p style="margin:0;font:400 16px/1.65 Georgia,'Times New Roman',serif;color:#FFFFFF;">
                    That is the approach behind the Build: investigate what the market is showing us, define your position and service, then express them through your LinkedIn profile, posts and message openers.
                  </p>
                </td>
              </tr>
            </table>

            <p style="margin:20px 0 14px;font:400 16px/1.65 Georgia,'Times New Roman',serif;color:#14100F;">
              If you want help turning the evidence into something concrete—not just another list of things to fix—you can explore the Build here.
            </p>

            <p style="margin:0;font:700 14px/1.5 Arial,Helvetica,sans-serif;">
              <a href="${esc(BUILD_URL)}" style="color:#C00068;text-decoration:underline;">
                See how the Build works &rarr;
              </a>
            </p>
          </td>
        </tr>`
      : '';

  const followUpSection = consent
    ? `
      <tr>
        <td style="padding:0 24px 24px;">
          <p style="margin:0;font:400 16px/1.65 Georgia,'Times New Roman',serif;color:#14100F;">
            In the next email, I’ll show you how to look for patterns in your recent opportunities before deciding what to change.
          </p>
        </td>
      </tr>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Your Why-Hire-You Scorecard results</title>
</head>

<body style="margin:0;padding:0;background:#FAF6F1;">

  <div style="display:none;font-size:1px;line-height:1px;color:#FAF6F1;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">
    Your score is a starting point. Buyer evidence tells us what to fix.
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FAF6F1;">
    <tr>
      <td align="center" style="padding:16px 10px;">

        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#FFFFFF;">

          <tr>
            <td style="background:#E4007C;padding:28px 24px 30px;">

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font:700 12px/1.4 Arial,Helvetica,sans-serif;color:#FFFFFF;letter-spacing:.08em;">
                    BRENDA BLANCHE
                  </td>
                  <td align="right" style="font:700 12px/1.4 Arial,Helvetica,sans-serif;color:#FFFFFF;">
                    01
                  </td>
                </tr>
              </table>

              <p style="margin:26px 0 10px;font:700 11px/1.5 Arial,Helvetica,sans-serif;color:#FFFFFF;letter-spacing:.12em;text-transform:uppercase;">
                Why-Hire-You Scorecard
              </p>

              <h1 style="margin:0 0 12px;font:700 29px/1.18 Georgia,'Times New Roman',serif;color:#FFFFFF;">
                Your results show where to look first.
              </h1>

              <p style="margin:0;font:400 16px/1.55 Georgia,'Times New Roman',serif;color:#FFFFFF;">
                Not a verdict on your expertise. A starting point for investigating what buyers see.
              </p>

            </td>
          </tr>

          <tr>
            <td style="padding:30px 24px 24px;">

              <p style="margin:0 0 18px;font:400 16px/1.65 Georgia,'Times New Roman',serif;color:#14100F;">
                Hi ${esc(firstName)},
              </p>

              <p style="margin:0 0 18px;font:400 16px/1.65 Georgia,'Times New Roman',serif;color:#14100F;">
                Your Why-Hire-You Scorecard results are ready.
              </p>

              <p style="margin:0 0 20px;font:400 16px/1.65 Georgia,'Times New Roman',serif;color:#14100F;">
                Inside, you’ll find your breakdown across all six areas, where to investigate first, and practical next steps based on your answers.
              </p>

              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="background:#E4007C;">
                    <a href="${esc(url)}" style="display:inline-block;padding:15px 22px;color:#FFFFFF;text-decoration:none;font:700 13px/1.3 Arial,Helvetica,sans-serif;letter-spacing:.04em;">
                      VIEW MY RESULTS
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:14px 0 0;font:400 13px/1.6 Arial,Helvetica,sans-serif;color:#6B625B;">
                Button not working?
                <a href="${esc(url)}" style="color:#C00068;text-decoration:underline;">
                  Open your results here.
                </a>
              </p>

            </td>
          </tr>

          <tr>
            <td style="padding:0 24px 26px;">

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FAF6F1;border-left:4px solid #E4007C;">
                <tr>
                  <td style="padding:20px 18px;">
                    ${situation}
                    <p style="margin:0;font:400 16px/1.65 Georgia,'Times New Roman',serif;color:#14100F;">
                      ${resultLine}
                    </p>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <tr>
            <td style="padding:0 24px 26px;">

              <p style="margin:0 0 14px;font:700 19px/1.4 Georgia,'Times New Roman',serif;color:#C00068;">
                Before you rewrite anything, check what actually happened.
              </p>

              <p style="margin:0 0 16px;font:400 16px/1.65 Georgia,'Times New Roman',serif;color:#14100F;">
                Think of your last three genuine opportunities: an enquiry, a referral, a proposal or a serious conversation about your work.
              </p>

              <p style="margin:0 0 12px;font:400 16px/1.65 Georgia,'Times New Roman',serif;color:#14100F;">
                For each one, write down:
              </p>

              <ul style="margin:0 0 18px;padding-left:20px;font:400 16px/1.65 Georgia,'Times New Roman',serif;color:#14100F;">
                <li style="margin-bottom:8px;">Where the person came from.</li>
                <li style="margin-bottom:8px;">The problem they described, in their own words.</li>
                <li style="margin-bottom:8px;">What they asked you about.</li>
                <li>What happened next.</li>
              </ul>

              <p style="margin:0 0 16px;font:400 16px/1.65 Georgia,'Times New Roman',serif;color:#14100F;">
                If you do not know why someone went quiet, write <em>unknown</em>. A missing answer is more useful than a confident guess.
              </p>

              <p style="margin:0;font:400 16px/1.65 Georgia,'Times New Roman',serif;color:#14100F;">
                This gives you something to compare with your scorecard: do your recent opportunities point to the same area, or suggest a different question to investigate?
              </p>

            </td>
          </tr>

          ${buildSection}
          ${followUpSection}

          <tr>
            <td style="padding:0 24px 28px;">
              <p style="margin:0 0 4px;font:700 19px/1.3 Georgia,'Times New Roman',serif;color:#14100F;">
                Brenda
              </p>
              <p style="margin:0;font:400 12px/1.5 Arial,Helvetica,sans-serif;color:#6B625B;letter-spacing:.05em;">
                MARKET PERCEPTION STRATEGIST
              </p>
            </td>
          </tr>

          <tr>
            <td style="background:#FAF6F1;border-top:1px solid #E6DFD8;padding:18px 24px 22px;">
              <p style="margin:0;font:400 11px/1.6 Arial,Helvetica,sans-serif;color:#6B625B;">
                Brenda Blanche · You are receiving this email because you completed the Why-Hire-You Scorecard and requested your results.${
                  consent
                    ? ' You also opted in to practical follow-up emails. You can unsubscribe using the link in those follow-up emails.'
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

/* Detailed notification sent to Brenda. */

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
  const row = (label, value) =>
    `<tr>
      <td style="padding:6px 14px 6px 0;color:#6b625b;vertical-align:top;">
        ${esc(label)}
      </td>
      <td style="padding:6px 0;">
        <b>${value}</b>
      </td>
    </tr>`;

  const [story, tried] = question.split('\n\nAlready tried: ');

  const events = ans
    ? ans.filter(answer => answer.s >= 3).length
    : null;

  const quote = text =>
    `<p style="margin:0 0 10px;padding:12px 14px;border-left:3px solid #E4007C;background:#faf6f1;white-space:pre-wrap;">${esc(text)}</p>`;

  return `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#14100F;">

    <p style="font-size:18px;">
      <b>${esc(name)}</b> just took the Why-Hire-You Scorecard.
    </p>

    <table style="border-collapse:collapse;">
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

      ${row(
        'Priority area',
        esc(gaps.join(' + ') || 'None flagged')
      )}

      ${row('Offer path (Brevo)', esc(path))}

      ${row(
        'Total (context only)',
        esc(finiteNumber(d.score)) + ' / 72'
      )}

      ${
        events === null
          ? ''
          : row(
              'Answers based on real events',
              esc(events) + ' / 18'
            )
      }
    </table>

    ${
      story
        ? `<p style="margin:18px 0 6px;">
             <b>The last time a potential client asked what they do (their words)</b>
           </p>
           ${quote(story)}`
        : ''
    }

    ${
      tried
        ? `<p style="margin:12px 0 6px;">
             <b>What they have already tried or paid for (their words)</b>
           </p>
           ${quote(tried)}`
        : ''
    }

    <p style="margin:18px 0 6px;">
      <b>Six-dimension breakdown</b>
    </p>

    <table style="border-collapse:collapse;">
      ${
        DIMS.map(
          (dimension, i) =>
            row(
              dimension,
              `${scores[i]} / 12 &middot; ${esc(band(scores[i]))}`
            )
        ).join('')
      }
    </table>

    ${
      ans
        ? `<p style="margin:18px 0 6px;">
             <b>Their answers, question by question</b>
           </p>` +
          DIMS.map(
            (dimension, dimensionIndex) =>
              `<p style="margin:12px 0 4px;color:#E4007C;">
                 <b>${esc(dimension)}</b>
               </p>` +
              [0, 1, 2]
                .map(offset => {
                  const i = dimensionIndex * 3 + offset;

                  return `<p style="margin:0 0 6px;">
                    <span style="color:#6b625b;">
                      Q${i + 1} ${esc(QLABELS[i])}:
                    </span>
                    <br>
                    ${ans[i].s}/4 &middot; ${esc(ans[i].t)}
                  </p>`;
                })
                .join('')
          ).join('')
        : ''
    }

    <p style="margin:18px 0 6px;">
      <b>About them</b>
    </p>

    <table style="border-collapse:collapse;">
      ${row('Role / industry', esc(t(d.role)) || '(blank)')}
      ${row(
        'What a client would hire them for',
        esc(t(d.service)) || '(blank)'
      )}
      ${row(
        'Their last best client',
        esc(t(d.audience)) || '(blank)'
      )}
    </table>

    ${
      url
        ? `<p style="margin-top:18px;">
             <a href="${esc(url)}">Open their results page</a>
           </p>`
        : ''
    }

  </div>`;
}

async function handle(request, env) {
  let d;

  try {
    d = await request.json();
  } catch {
    return json(
      { ok: false, error: 'Invalid JSON.' },
      400
    );
  }

  if (!d || typeof d !== 'object' || Array.isArray(d)) {
    return json(
      { ok: false, error: 'Invalid submission.' },
      400
    );
  }

  if (d['bot-field']) {
    return json({ ok: true });
  }

  const email = t(d.email).toLowerCase();
  const name = t(d.name);

  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json(
      { ok: false, error: 'A valid name and email are required.' },
      400
    );
  }

  const consent = d.consent === true;

  const scores = [
    d.market_problem,
    d.offer_design,
    d.positioning,
    d.evidence_trust,
    d.signals,
    d.buyer_journey
  ].map(boundedScore);

  const ans = cleanAnswers(d.answers);

  const kind = ['single', 'combined', 'strong'].includes(d.result_type)
    ? d.result_type
    : '';

  const gaps = gapNames(d.primary_gap);

  let url = '';

  try {
    const candidate = new URL(String(d.results_url || ''));
    const requestOrigin = new URL(request.url).origin;

    if (
      candidate.origin === requestOrigin &&
      ['http:', 'https:'].includes(candidate.protocol)
    ) {
      /*
        Preserve the complete results URL.
        Do not truncate an encoded report URL mid-payload.
      */
      url = candidate.toString();
    }
  } catch {
    url = '';
  }

  const seg = Object.prototype.hasOwnProperty.call(SEGL, d.segment)
    ? d.segment
    : '';

  const ready = [1, 2, 3, 4].includes(Number(d.deliver))
    ? Number(d.deliver)
    : 0;

  const help = [1, 2, 3, 4].includes(Number(d.help))
    ? Number(d.help)
    : 0;

  const question = q1100(d.question);

  const path = offerPath(kind, ready, help);
  const today = new Date().toISOString().slice(0, 10);

  const core = {
    FIRSTNAME: name,
    SCORE: finiteNumber(d.score),
    RESULT_TYPE: kind,
    CONSENT: consent,
    RESULTS_URL: url,
    PRIMARY_GAP: gaps.join(' + '),
    SECONDARY_GAP: gapNames(d.secondary_gap).join(' + '),
    PRIMARY_SCORE: finiteNumber(d.primary_score),
    SECONDARY_SCORE: finiteNumber(d.secondary_score),
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
    SCORECARD_DATE: today
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
        QKEYS.map((key, i) => [
          key,
          `${ans[i].s}/4 \u00B7 ${ans[i].t}`
        ])
      )
    : {};

  const listId = Number(env.BREVO_LIST_ID);

  const ids =
    Number.isInteger(listId) && listId > 0
      ? [listId]
      : undefined;

  const saveContact = async () => {
    /*
      Every attempt retains core consent and routing data.
      The previous name-only fallback has been removed.
    */
    const tiers = [
      { ...core, ...extra, ...answerAttrs },
      { ...core, ...extra },
      core
    ];

    for (let i = 0; i < tiers.length; i++) {
      const response = await brevo(env, {
        email,
        attributes: tiers[i],
        ...(ids ? { listIds: ids } : {}),
        updateEnabled: true
      });

      if (response.ok) {
        console.log('Brevo scorecard contact saved', {
          tier: i + 1
        });

        return true;
      }

      console.error('Brevo scorecard save failed', {
        status: response.status,
        tier: i + 1
      });

      if (response.status !== 400) {
        return false;
      }
    }

    return false;
  };

  const sendChecked = async (...args) => {
    const response = await resend(...args);

    if (!response.ok) {
      console.error('Resend email request failed', {
        status: response.status
      });
    }

    return response.ok;
  };

  /*
    Defer each job so one synchronous setup error does not
    prevent the other independent jobs from being attempted.
  */

  const jobs = [
    Promise.resolve().then(() =>
      env.BREVO_API_KEY
        ? saveContact()
        : false
    ),

    Promise.resolve().then(() =>
      env.RESEND_API_KEY && env.RESEND_FROM && env.NOTIFY_EMAIL
        ? sendChecked(
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
          )
        : false
    ),

    Promise.resolve().then(() =>
      env.RESEND_API_KEY && env.RESEND_FROM && url
        ? sendChecked(
            env,
            email,
            `${firstNameOf(name)}, your results show where to look first`,
            firstEmail(
              name,
              kind,
              gaps,
              url,
              consent,
              seg,
              path
            ),
            env.NOTIFY_EMAIL,
            firstEmailText(
              name,
              kind,
              gaps,
              url,
              consent,
              seg,
              path
            )
          )
        : false
    )
  ];

  const settled = await Promise.allSettled(jobs);

  const jobNames = [
    'brevo_contact',
    'brenda_notification',
    'participant_results'
  ];

  settled.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.error('Scorecard job failed', {
        job: jobNames[i],
        errorType: result.reason?.name || 'Error'
      });
    }
  });

  const [contact, notified, welcomed] = settled.map(
    result =>
      result.status === 'fulfilled' &&
      result.value === true
  );

  /*
    Preserve the existing response contract:
      ok = at least one job succeeded.

    welcomed = Resend accepted the participant email request.
    It is not confirmation of inbox delivery.
  */

  return contact || notified || welcomed
    ? json({
        ok: true,
        contact,
        notified,
        welcomed
      })
    : json(
        {
          ok: false,
          contact,
          notified,
          welcomed
        },
        502
      );
}

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;

    if (pathname === '/api/scorecard') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', {
          status: 405,
          headers: {
            Allow: 'POST'
          }
        });
      }

      return handle(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};
