/* ============================================================
   MindRead - 대화 분석 프론트엔드 로직
   (서버/AI 연동 전이라 규칙 기반 휴리스틱으로 결과를 생성합니다)
   ============================================================ */

(function () {
  'use strict';

  const STORAGE_KEY = 'mindread_history';

  /* ---------- 대화에서 실제 상대방 말 뽑아내기 ---------- */
  // "상사: 요즘 팀 분위기 어때요?" 처럼 화자 표시가 있으면 마지막 줄, 그 안의 화자 이름을 제거해서
  // 진짜 "상대방이 한 말"만 남긴다. 답변 예시가 이 문구를 반영해야 안 맞다는 느낌이 안 든다.
  // 카톡 스크린샷을 OCR로 읽으면 "오후 3:42" 같은 시간 표시나 숫자만 있는 줄(안읽음 표시 등)이
  // 대화 내용인 것처럼 섞여 들어오는 경우가 많아서, 그런 줄은 실제 대화가 아니라고 보고 건너뛴다.
  function looksLikeNoiseLine(line) {
    if (/^(오전|오후)?\s*\d{1,2}[:시]\d{0,2}분?$/.test(line)) return true;
    if (/^\d{1,3}$/.test(line)) return true;
    if (!line.replace(/[^0-9a-zA-Z가-힣]/g, '')) return true;
    return false;
  }

  function extractOtherLine(text) {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean).filter((l) => !looksLikeNoiseLine(l));
    const last = lines.length ? lines[lines.length - 1] : text.trim();
    const stripped = last.replace(/^[^\s:：]{1,12}\s*[:：]\s*/, '').trim();
    return stripped || text.trim();
  }

  // OCR 결과에서 빈 줄과 시간 표시 등 잡음 줄을 정리해서, 사용자가 보는 대화 입력창도 깔끔해지게 한다.
  function cleanOcrText(text) {
    return text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !looksLikeNoiseLine(l))
      .join('\n');
  }

  function shortQuote(line, max) {
    const limit = max || 22;
    const t = line.replace(/["""]/g, '').trim();
    return t.length > limit ? `${t.slice(0, limit)}…` : t;
  }

  /* ---------- 오타에 강한(fuzzy) 키워드 매칭 ---------- */
  // OCR로 읽은 글자는 띄어쓰기가 틀어지거나 한두 글자가 잘못 인식되기 쉽다.
  // 완전히 똑같은 문자열이어야만 인식하면 오타 하나로도 엉뚱한 결과가 나오니,
  // 공백을 무시하고, 한두 글자 정도 다른 것도 같은 단어로 봐준다.
  function normalizeForMatch(str) {
    return str.replace(/\s+/g, '').toLowerCase();
  }

  function levenshteinDistance(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const curr = [i];
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      }
      prev = curr;
    }
    return prev[b.length];
  }

  function fuzzyIncludes(text, keyword) {
    const normText = normalizeForMatch(text);
    const normKw = normalizeForMatch(keyword);
    if (!normKw) return false;
    if (normText.includes(normKw)) return true;
    if (normKw.length < 3) return false; // 너무 짧은 키워드는 오탐 방지를 위해 정확히 일치할 때만 인정

    const maxDistance = normKw.length <= 4 ? 1 : 2;
    for (let i = 0; i <= normText.length - (normKw.length - maxDistance); i++) {
      for (let lenDelta = -maxDistance; lenDelta <= maxDistance; lenDelta++) {
        const len = normKw.length + lenDelta;
        if (len < 1 || i + len > normText.length) continue;
        const chunk = normText.slice(i, i + len);
        if (levenshteinDistance(chunk, normKw) <= maxDistance) return true;
      }
    }
    return false;
  }

  /* ---------- 의도/감정/목적 판별 규칙 ---------- */
  // intent/purpose/emotion은 문자열 하나가 아니라 여러 표현을 담은 배열이다.
  // 같은 유형으로 분석돼도 매번 같은 문장만 나오면 단조로우니, 분석할 때마다 그중 하나를 무작위로 골라 쓴다.
  function pickOne(value) {
    return Array.isArray(value) ? value[Math.floor(Math.random() * value.length)] : value;
  }

  // replies는 고정 문장이 아니라 실제 상대방 말(line)을 받아서 그 자리에서 답을 만들어내는 함수.
  // 그래야 매번 같은 3문장이 아니라 입력한 대화에 맞는 답변이 나온다.
  const INTENT_RULES = [
    {
      tone: 'distancing',
      keywords: ['다음에', '나중에', '바쁘', '됐어', '괜찮아 안 해도', '아니야 괜찮', '신경쓰지마', '어쩔 수 없지', '그냥 넘어가자', '알겠어 그럼'],
      intent: [
        '갈등 없이 완곡하게 거리를 두거나 거절하려는 것',
        '싫은 티 안 내면서 은근슬쩍 발을 빼려는 것',
        '직접 거절하면 미안하니까, 돌려서 부담을 줄이려는 것'
      ],
      purpose: [
        '직접 거절해서 관계가 어색해지는 상황을 피하려는 것',
        '갈등이나 서운함을 만들지 않고 넘어가려는 것',
        '나중에라도 관계에 부담이 남지 않게 하려는 것'
      ],
      emotion: [
        '무심함 속에 약간의 부담·서운함',
        '귀찮음과 미안함이 뒤섞인 상태',
        '벗어나고 싶은 마음과 눈치 보는 마음이 공존'
      ],
      recommendations: [
        '지금 바로 답을 요구하지 말고 "괜찮아, 편할 때 얘기해줘"처럼 여유를 주세요.',
        '상대가 거절하기 쉬운 대안을 함께 제시해보세요. (예: "그럼 다음 주는 어때?")',
        '서운한 티를 내기보다 상대의 상황을 먼저 물어보며 진짜 이유를 확인하세요.'
      ],
      replies: (line) => [
        `"${shortQuote(line)}" 라고 했으니, 그래 알겠어~ 편할 때 얘기해줘.`,
        '나도 딱히 급한 건 아니었어, 부담 갖지 말고 천천히 말해도 돼.',
        '혹시 요즘 좀 바빠? 그럼 다음 주쯤 다시 얘기해볼까'
      ]
    },
    {
      tone: 'soft-request',
      keywords: ['혹시', '괜찮으면', '시간 되면', '가능하면', '부탁', '해줄 수 있어', '해줄래', '어렵겠지만', '미안한데', '실례가 안된다면'],
      intent: [
        '거절당할 부담 없이 조심스럽게 요청하거나 제안하려는 것',
        '부담 주지 않으려고 조심스럽게 운을 떼보는 것',
        '거절해도 괜찮다는 걸 미리 표현하며 부탁하려는 것'
      ],
      purpose: [
        '직접적으로 요구하기보다 상대가 편하게 응할 여지를 남기려는 것',
        '상대가 부담 없이 거절할 수 있는 퇴로를 열어두려는 것',
        '관계를 해치지 않으면서 원하는 걸 얻어내려는 것'
      ],
      emotion: [
        '기대감과 조심스러움이 섞인 상태',
        '설렘 반, 거절당할까 봐 걱정 반',
        '조심스러움 속에 은근한 기대'
      ],
      recommendations: [
        '상대가 조심스럽게 꺼낸 부탁이니, 가능/불가능을 명확히 답해주면 안심시킬 수 있어요.',
        '바로 답하기 어렵다면 "언제까지 알려주면 될까?"로 여유를 되물어보세요.',
        '거절해야 한다면 이유를 짧게 덧붙여 상대가 오해하지 않도록 해주세요.'
      ],
      replies: (line) => [
        `"${shortQuote(line)}" 응 괜찮아, 몇 시쯤이 좋을까?`,
        '미안 그때는 좀 어려운데, 다른 날로 잡아도 될까?',
        '고마워 이렇게 물어봐줘서, 한번 생각해보고 오늘 안에 알려줄게'
      ]
    },
    {
      tone: 'probe',
      keywords: ['요즘 어때', '잘 지내', '별일 없', '어떻게 지내', '분위기 어때', '무슨 일 있어', '표정이 왜', '힘들어 보여', '기분 안좋아 보여'],
      intent: [
        '가볍게 안부를 묻는 척하며 실제로는 상태나 분위기를 살피려는 것',
        '별거 아닌 척 물어보면서 슬쩍 반응을 떠보려는 것',
        '직접 묻기 애매한 걸 안부 인사 뒤에 숨겨서 물어보는 것'
      ],
      purpose: [
        '민감한 주제를 직접 묻기 전에 상대의 반응이나 근황을 먼저 탐색하려는 것',
        '분위기나 상태를 먼저 파악해서 다음 말을 어떻게 할지 정하려는 것',
        '상대가 편하게 반응할 수 있는 선에서 조심스럽게 다가가려는 것'
      ],
      emotion: [
        '궁금함과 약간의 경계심',
        '호기심 속에 살짝 조심스러운 마음',
        '걱정과 궁금함이 함께 있는 상태'
      ],
      recommendations: [
        '너무 방어적으로 답하기보다 짧고 담백하게 근황을 공유해보세요.',
        '상대가 특정 주제를 궁금해하는 것 같다면 되물어서 진짜 의도를 확인해보세요. (예: "혹시 궁금한 거 있어?")',
        '민감한 내용이라면 지금 바로 다 말하기보다 다음 대화로 자연스럽게 넘겨도 괜찮아요.'
      ],
      replies: (line) => [
        `"${shortQuote(line)}" 라고 물어보셔서요, 저는 그냥 무난하게 잘 지내고 있어요 :)`,
        '갑자기 물어보시니 궁금하네요, 혹시 따로 확인하고 싶으신 부분 있으세요?',
        '딱히 특별한 일은 없어요, 궁금하신 거 있으면 편하게 말씀해주세요'
      ]
    },
    {
      tone: 'evaluate',
      keywords: ['확인', '체크', '보고', '왜', '진행 상황', '언제까지', '누가 담당', '책임', '근거', '데이터로'],
      intent: [
        '책임 소재를 확인하거나 진행 상황을 평가하려는 것',
        '문제가 생기기 전에 상황을 미리 점검해두려는 것',
        '누가 어디까지 챙기고 있는지 확인해서 통제하려는 것'
      ],
      purpose: [
        '업무나 상황에 대한 통제권을 확보하고 리스크를 미리 점검하려는 것',
        '나중에 문제가 커지기 전에 미리 짚고 넘어가려는 것',
        '진행 상황을 파악해서 필요하면 바로 조치하려는 것'
      ],
      emotion: [
        '긴장감과 압박감',
        '신경이 곤두선 상태와 확인하고 싶은 조급함',
        '걱정과 경계심이 섞인 예민한 상태'
      ],
      recommendations: [
        '변명보다 현재 상황과 다음 계획을 구체적인 숫자·기한으로 먼저 제시하세요.',
        '문제가 있다면 숨기지 말고 원인과 대응 방안을 함께 보고하면 신뢰를 얻을 수 있어요.',
        '질문의 의도가 불명확하면 "어떤 부분이 궁금하신 건가요?"로 범위를 좁혀 답하세요.'
      ],
      replies: (line) => [
        `"${shortQuote(line)}" 말씀 주신 부분, 지금까지 진행된 내용부터 정리해서 공유드릴게요.`,
        '아 확인 감사합니다, 놓친 부분이 있었네요. 바로 다시 확인해서 알려드리겠습니다.',
        '혹시 어떤 부분이 특히 궁금하신 건지 여쭤봐도 될까요? 거기부터 자세히 답해드릴게요'
      ]
    },
    {
      tone: 'repair',
      keywords: ['미안', '죄송', '내 잘못', '오해', '화해', '용서', '다시 잘 지내자', '내가 미안해'],
      intent: [
        '갈등을 빨리 진정시키고 관계를 회복하려는 것',
        '더 틀어지기 전에 먼저 손을 내밀어 풀어보려는 것',
        '서로 마음 상하지 않게 조심스럽게 화해하려는 것'
      ],
      purpose: [
        '긴장된 관계를 완화하고 다시 좋은 분위기로 되돌리려는 것',
        '어색해진 사이를 원래대로 돌려놓으려는 것',
        '갈등이 더 커지지 않게 먼저 매듭을 지으려는 것'
      ],
      emotion: [
        '미안함과 조심스러움',
        '후회와 걱정이 뒤섞인 마음',
        '미안함 속에 관계를 회복하고 싶은 간절함'
      ],
      recommendations: [
        '사과를 받아들일지 아직 감정이 남아있는지 스스로 먼저 점검해보세요.',
        '앙금이 남아있다면 "괜찮아"로 넘기기보다 솔직하게 감정을 짧게 표현해보세요.',
        '같은 문제가 반복되지 않도록 재발 방지에 대한 한마디를 더해보세요.'
      ],
      replies: (line) => [
        `"${shortQuote(line)}" 그렇게 말해줘서 고마워, 나도 좀 예민하게 반응했던 것 같아.`,
        '괜찮아, 근데 다음엔 그런 부분 좀 조심해줬으면 좋겠어.',
        '우리 이 얘기는 여기서 끝내고 다시 편하게 지내자'
      ]
    },
    {
      tone: 'affection',
      keywords: ['보고싶', '연락해', '같이 가자', '데이트', '좋아해', '설레', '두근', '자니', '오늘 뭐해', '심쿵'],
      intent: [
        '호감이나 친밀감을 은근히 드러내며 반응을 살피려는 것',
        '직접 고백은 아니지만 관심을 슬쩍 흘려서 눈치를 보려는 것',
        '마음을 들키지 않는 선에서 살짝 다가가보려는 것'
      ],
      purpose: [
        '직접 고백하기 전에 상대의 관심 정도를 확인하려는 것',
        '거절당해도 덜 민망한 선에서 마음을 확인해보려는 것',
        '천천히 가까워지면서 상대의 반응을 살피려는 것'
      ],
      emotion: [
        '설렘과 동시에 거절에 대한 불안',
        '두근거림과 조마조마함이 함께 있는 상태',
        '기대감 속에 살짝 긴장되는 마음'
      ],
      recommendations: [
        '관심이 있다면 비슷한 온도로 화답해 상대가 안심하고 다가올 수 있게 해주세요.',
        '아직 확신이 없다면 부담 없는 선에서 가볍게 약속을 잡아 관계를 지켜봐도 좋아요.',
        '관심이 없다면 모호하게 답하기보다 정중하고 분명하게 의사를 표현해주세요.'
      ],
      replies: (line) => [
        `"${shortQuote(line)}" 나도 좋아, 우리 언제 한번 볼까?`,
        '그렇게 말해주니까 고마운데, 아직은 조금 더 편하게 지내면서 알아가고 싶어.',
        '그 말 들으니까 기분 좋다 ㅎㅎ 나도 더 친해지고 싶어'
      ]
    }
  ];

  const DEFAULT_RULE = {
    tone: 'default',
    intent: [
      '표면적인 말과는 다른 속마음이 담겨 있을 가능성이 높은 것',
      '말한 것 이상의 감정이나 의도가 숨어 있을 가능성이 있는 것',
      '지금 상황만으로는 진짜 의도를 단정짓기 어려운 것'
    ],
    purpose: [
      '직접적으로 드러내기 조심스러운 감정이나 요구가 있는 것',
      '아직 명확히 드러나지 않은 마음이나 상황이 있는 것',
      '조금 더 대화를 나눠봐야 확실해질 것 같은 부분이 있는 것'
    ],
    emotion: [
      '겉으로 드러나지 않는 복합적인 감정',
      '한 가지로 단정하기 어려운 여러 감정이 섞인 상태',
      '표면적으로 드러난 것보다 미묘하게 다른 감정'
    ],
    recommendations: [
      '바로 결론을 내리기보다 "그게 무슨 뜻이야?"처럼 한 번 더 확인해보세요.',
      '상대의 평소 말투와 비교해 이번 대화에서 달라진 점이 있는지 살펴보세요.',
      '판단이 어렵다면 시간을 두고 다음 대화에서 힌트를 더 모아보세요.'
    ],
    replies: (line) => [
      `"${shortQuote(line)}" 그게 정확히 무슨 뜻이야? 조금 더 편하게 말해줘도 돼.`,
      '나는 이렇게 이해했는데, 맞게 이해한 거 맞아?',
      '혹시 내가 오해한 부분 있으면 편하게 알려줘'
    ]
  };

  /* ---------- 나도 숨은 의도로 물어보기 (반대 방향: 직설적인 말 -> 완곡한 표현) ---------- */
  const ASK_RULES = [
    {
      tone: 'refuse',
      keywords: ['싫어', '가기 싫', '안 하고 싶', '못 하겠어', '하기 싫', '별로', '못가', '안 갈래', '패스할래', '빠질래', '내키지 않아'],
      suggestions: [
        '그날 컨디션이 좀 안 좋을 것 같아서, 이번엔 참석이 어려울 것 같아요.',
        '다른 일정이 겹칠 것 같은데, 다음 기회에 함께해도 될까요?',
        '요즘 좀 바빠서 이번엔 힘들 것 같아요, 다음엔 꼭 챙길게요.'
      ]
    },
    {
      tone: 'request',
      keywords: ['해줘', '부탁', '도와줘', '필요해', '도움', '해주라', '해주면 안돼', '가능할까', '좀 봐줘'],
      suggestions: [
        '혹시 시간 괜찮으시면 이 부분 한번 봐주실 수 있을까요?',
        '바쁘시면 나중에 여유 되실 때 알려주셔도 괜찮아요.',
        '죄송한데 급하게 부탁 하나만 드려도 될까요?'
      ]
    },
    {
      tone: 'complaint',
      keywords: ['서운', '섭섭', '화나', '짜증', '불만', '실망', '속상해', '너무해', '왜 그래'],
      suggestions: [
        '그때 좀 아쉬웠던 것 같아요, 다음엔 조금만 더 신경 써주시면 좋을 것 같아요.',
        '혹시 그렇게 하신 데는 이유가 있으셨을까요?',
        '별건 아닌데, 그 부분은 저한테 먼저 얘기해주시면 더 좋을 것 같아요.'
      ]
    },
    {
      tone: 'affection',
      keywords: ['좋아해', '만나고 싶', '데이트', '보고 싶', '설레', '자니', '연락 좀', '만나자'],
      suggestions: [
        '요즘 자주 생각나네, 우리 언제 한번 시간 맞춰서 볼까?',
        '혹시 다음에 같이 밥 한번 먹지 않을래?',
        '너랑 있으면 편한 것 같아, 앞으로도 자주 보고 싶어.'
      ]
    },
    {
      tone: 'question',
      keywords: ['왜 그랬', '진짜야', '맞아?', '사실이야', '진심이야', '정말이야', '진짜냐'],
      suggestions: [
        '혹시 무슨 일 있었어? 편하게 얘기해줘도 돼.',
        '그때 어떤 상황이었는지 궁금해서 물어보는 거야.',
        '오해면 좋겠는데, 그냥 한번 확인해보고 싶어서.'
      ]
    }
  ];

  const ASK_DEFAULT_RULE = {
    tone: 'default',
    suggestions: [
      '제 생각에는 이 부분을 조금 다르게 보면 좋을 것 같아요, 한번 얘기 나눠봐도 될까요?',
      '혹시 괜찮으시면 이 부분에 대해 서로 의견을 맞춰보면 어떨까요?',
      '제가 보기엔 이런 부분이 있는 것 같은데, 편하게 얘기해봐도 될까요?'
    ]
  };

  const TAG_CONTEXT = {
    '직장·모임': '직장 내 관계이므로 위계나 평가에 대한 부담이 섞여 있을 수 있어요.',
    '연인·가족': '가까운 사이일수록 돌려 말하는 표현 속에 애정이나 서운함이 함께 담겨 있을 수 있어요.',
    '친구': '편한 사이일수록 오히려 서운함이나 진심을 직접 말하기보다 장난스럽게 돌려 표현할 수 있어요.',
    '비즈니스': '이해관계가 걸려 있는 자리이므로 말속에 협상 여지나 조건이 숨어 있을 수 있어요.',
    '기타': ''
  };

  const POSITIVE_WORDS = ['좋아', '고마워', '기대', '반가워', '행복', '재밌'];
  const NEGATIVE_WORDS = ['화나', '짜증', '서운', '속상', '불안', '걱정', '힘들'];

  /* ---------- 상황 태그 선택 ---------- */
  let selectedTag = null;
  const tagButtons = Array.from(document.querySelectorAll('.situation-tag'));

  tagButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const alreadySelected = btn.classList.contains('is-selected');
      tagButtons.forEach((b) => b.classList.remove('is-selected'));
      if (!alreadySelected) {
        btn.classList.add('is-selected');
        selectedTag = btn.dataset.tag;
      } else {
        selectedTag = null;
      }
    });
  });

  /* ---------- 분석 로직 ---------- */
  // 첫 번째로 걸리는 규칙을 무조건 채택하면, 짧고 흔한 키워드 하나 때문에
  // 실제로는 더 잘 맞는 다른 규칙이 있어도 무시되는 문제가 있었다.
  // 그래서 모든 규칙의 매칭 점수(매칭된 키워드 글자 수 합)를 비교해 가장 잘 맞는 규칙을 고른다.
  function scoreKeywordMatch(text, rules) {
    let bestRule = null;
    let bestScore = 0;
    rules.forEach((rule) => {
      const score = rule.keywords.reduce((acc, kw) => acc + (fuzzyIncludes(text, kw) ? kw.length : 0), 0);
      if (score > bestScore) {
        bestScore = score;
        bestRule = rule;
      }
    });
    return bestRule;
  }

  function matchRule(text) {
    return scoreKeywordMatch(text, INTENT_RULES) || DEFAULT_RULE;
  }

  function detectEmotionHint(text, emotion) {
    const hasPositive = POSITIVE_WORDS.some((w) => fuzzyIncludes(text, w));
    const hasNegative = NEGATIVE_WORDS.some((w) => fuzzyIncludes(text, w));
    if (hasPositive && !hasNegative) return `${emotion} (표면적으로는 긍정적인 표현도 함께 보여요)`;
    if (hasNegative && !hasPositive) return `${emotion} (부정적인 감정 단서도 함께 드러나요)`;
    return emotion;
  }

  function calcConfidence(text, rule) {
    const matchedCount = rule.keywords ? rule.keywords.filter((kw) => fuzzyIncludes(text, kw)).length : 0;
    const lengthBonus = Math.min(text.trim().length / 20, 10);
    let confidence = 58 + matchedCount * 9 + lengthBonus;
    confidence += Math.floor(Math.random() * 6); // 자연스러운 변주
    return Math.max(55, Math.min(97, Math.round(confidence)));
  }

  function analyzeConversation(text, tag) {
    const rule = matchRule(text);
    const basePurpose = pickOne(rule.purpose);
    const context = tag && TAG_CONTEXT[tag] ? TAG_CONTEXT[tag] : '';
    const purpose = context ? `${basePurpose}. ${context}` : basePurpose;
    const otherLine = extractOtherLine(text);

    return {
      intent: pickOne(rule.intent),
      emotion: detectEmotionHint(text, pickOne(rule.emotion)),
      purpose,
      confidence: calcConfidence(text, rule),
      recommendations: rule.recommendations,
      replies: rule.replies(otherLine)
    };
  }

  /* ---------- 결과 렌더링 ---------- */
  const analyzeButton = document.getElementById('analyze-button');
  const conversationInput = document.getElementById('conversation-input');
  const resultPanel = document.getElementById('analyzer-result-panel');
  const recommendPanel = document.getElementById('recommend-panel');
  const recommendList = document.getElementById('recommend-list');
  const replyPanel = document.getElementById('reply-panel');
  const replyList = document.getElementById('reply-list');

  const intentValueEl = document.getElementById('result-intent-value');
  const emotionValueEl = document.getElementById('result-emotion-value');
  const purposeValueEl = document.getElementById('result-purpose-value');
  const confidenceLabelEl = document.getElementById('confidence-meter-label');
  const confidenceBarEl = document.getElementById('confidence-meter-bar');

  function renderResult(result) {
    intentValueEl.textContent = result.intent;
    emotionValueEl.textContent = result.emotion;
    purposeValueEl.textContent = result.purpose;

    resultPanel.hidden = false;

    // 신뢰도 바 애니메이션 (0 -> 값)
    confidenceLabelEl.textContent = '신뢰도 0%';
    confidenceBarEl.style.width = '0%';
    requestAnimationFrame(() => {
      confidenceLabelEl.textContent = `신뢰도 ${result.confidence}%`;
      confidenceBarEl.style.width = `${result.confidence}%`;
    });

    recommendList.innerHTML = '';
    result.recommendations.forEach((tip) => {
      const li = document.createElement('li');
      li.textContent = tip;
      recommendList.appendChild(li);
    });
    recommendPanel.hidden = false;

    replyList.innerHTML = '';
    (result.replies || []).forEach((line) => {
      const li = document.createElement('li');
      li.textContent = line;
      replyList.appendChild(li);
    });
    replyPanel.hidden = false;

    resultPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function handleAnalyzeClick() {
    // 이미지에서 읽은 글자는 입력창에는 안 보이지만, 분석할 때는 타이핑한 내용과 함께 반영된다.
    const typedText = conversationInput.value.trim();
    const text = [typedText, ocrExtractedText].filter(Boolean).join('\n');
    if (!text) {
      alert('분석할 대화 내용을 입력하거나 스크린샷을 올려주세요.');
      conversationInput.focus();
      return;
    }

    const originalLabel = analyzeButton.textContent;
    analyzeButton.disabled = true;
    analyzeButton.textContent = '🔍 분석 중...';

    // 실제 서버 분석을 흉내내는 짧은 지연
    setTimeout(() => {
      const result = analyzeConversation(text, selectedTag);
      renderResult(result);
      saveHistoryEntry(text, selectedTag, result);

      analyzeButton.disabled = false;
      analyzeButton.textContent = originalLabel;
    }, 500);
  }

  if (analyzeButton) {
    analyzeButton.addEventListener('click', handleAnalyzeClick);
  }

  /* ---------- 이미지 속 글자 인식 (OCR) ---------- */
  // 서버나 API 키 없이, 브라우저에서 바로 이미지 속 텍스트를 읽는다.
  // 읽은 글자는 "분석할 대화 내용을 붙여넣어 주세요" 입력창에는 표시하지 않고,
  // 분석 버튼을 누를 때 내부적으로만 반영한다.
  const imageInput = document.getElementById('conversation-image-input');
  const imagePreviewWrap = document.getElementById('image-preview-wrap');
  const imagePreviewEl = document.getElementById('image-preview');
  const imageRemoveButton = document.getElementById('image-remove-button');
  const imageOcrStatusEl = document.getElementById('image-ocr-status');

  let imagePreviewUrl = null;
  let ocrExtractedText = '';

  function setOcrStatus(message, isError) {
    if (!imageOcrStatusEl) return;
    if (!message) {
      imageOcrStatusEl.hidden = true;
      imageOcrStatusEl.textContent = '';
      return;
    }
    imageOcrStatusEl.hidden = false;
    imageOcrStatusEl.textContent = message;
    imageOcrStatusEl.classList.toggle('is-error', Boolean(isError));
  }

  function resetImageUpload() {
    if (imagePreviewUrl) {
      URL.revokeObjectURL(imagePreviewUrl);
      imagePreviewUrl = null;
    }
    ocrExtractedText = '';
    if (imageInput) imageInput.value = '';
    if (imagePreviewWrap) imagePreviewWrap.hidden = true;
    setOcrStatus('');
  }

  async function handleImageSelected(file) {
    if (!file || !file.type.startsWith('image/')) {
      alert('이미지 파일만 업로드할 수 있어요.');
      resetImageUpload();
      return;
    }

    imagePreviewUrl = URL.createObjectURL(file);
    imagePreviewEl.src = imagePreviewUrl;
    imagePreviewWrap.hidden = false;

    if (typeof Tesseract === 'undefined') {
      setOcrStatus('글자 인식 기능을 불러오지 못했어요. 인터넷 연결을 확인해주세요.', true);
      return;
    }

    setOcrStatus('이미지에서 글자를 읽는 중이에요...');

    try {
      const { data } = await Tesseract.recognize(file, 'kor+eng');
      const recognizedText = cleanOcrText((data.text || '').trim());

      if (!recognizedText) {
        ocrExtractedText = '';
        setOcrStatus('이미지에서 글자를 찾지 못했어요. 다른 이미지로 시도해보세요.', true);
        return;
      }

      ocrExtractedText = recognizedText;

      if (recognizedText.length < 6) {
        setOcrStatus('글자를 조금밖에 못 읽었어요. 화질이 낮거나 글씨가 작으면 인식이 잘 안 될 수 있어요.', true);
      } else {
        setOcrStatus('이미지에서 글자를 다 읽었어요! "숨은 의도 분석하기" 버튼을 누르면 반영돼요.');
      }
    } catch (err) {
      setOcrStatus('이미지 인식에 실패했어요. 인터넷 연결을 확인하고 다시 시도해주세요.', true);
    }
  }

  if (imageInput) {
    imageInput.addEventListener('change', () => {
      const file = imageInput.files && imageInput.files[0];
      if (file) handleImageSelected(file);
    });
  }

  if (imageRemoveButton) {
    imageRemoveButton.addEventListener('click', resetImageUpload);
  }

  /* ---------- 나도 숨은 의도로 물어보기 ---------- */
  const askButton = document.getElementById('ask-button');
  const askInput = document.getElementById('ask-input');
  const askResultWrap = document.getElementById('ask-result-wrap');
  const askResultList = document.getElementById('ask-result-list');

  function handleAskClick() {
    const text = askInput.value.trim();
    if (!text) {
      alert('완곡하게 바꾸고 싶은 말을 입력해주세요.');
      askInput.focus();
      return;
    }

    const originalLabel = askButton.textContent;
    askButton.disabled = true;
    askButton.textContent = '🙈 바꾸는 중...';

    setTimeout(() => {
      const rule = scoreKeywordMatch(text, ASK_RULES) || ASK_DEFAULT_RULE;

      askResultList.innerHTML = '';
      rule.suggestions.forEach((line) => {
        const li = document.createElement('li');
        li.textContent = line;
        askResultList.appendChild(li);
      });
      askResultWrap.hidden = false;
      askResultWrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

      askButton.disabled = false;
      askButton.textContent = originalLabel;
    }, 400);
  }

  if (askButton) {
    askButton.addEventListener('click', handleAskClick);
  }

  /* ---------- 분석 히스토리 (localStorage 저장) ---------- */
  const historyListEl = document.getElementById('history-list');
  const historyEmptyMessageEl = document.getElementById('history-empty-message');
  const historyFilterEl = document.getElementById('history-filter-person');
  const historyExportButton = document.getElementById('history-export-button');
  const historyDeleteButton = document.getElementById('history-delete-selected-button');
  const historySelectAllWrap = document.getElementById('history-select-all-wrap');
  const historySelectAllCheckbox = document.getElementById('history-select-all-checkbox');

  const selectedHistoryIds = new Set();

  function loadHistory() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function persistHistory(list) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  }

  function saveHistoryEntry(text, tag, result) {
    const list = loadHistory();
    const entry = {
      id: `${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      date: new Date().toISOString(),
      tag: tag || '기타',
      preview: text.length > 40 ? `${text.slice(0, 40)}…` : text,
      intent: result.intent,
      emotion: result.emotion,
      purpose: result.purpose,
      confidence: result.confidence
    };
    list.unshift(entry);
    persistHistory(list);
    renderHistory();
  }

  function formatDate(iso) {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function renderHistory() {
    const list = loadHistory();
    const filterValue = historyFilterEl ? historyFilterEl.value : 'all';

    // 필터 옵션 갱신 (태그 종류 기준)
    if (historyFilterEl) {
      const currentValue = historyFilterEl.value;
      const tags = Array.from(new Set(list.map((item) => item.tag)));
      historyFilterEl.innerHTML = '<option value="all">전체 보기</option>';
      tags.forEach((tag) => {
        const opt = document.createElement('option');
        opt.value = tag;
        opt.textContent = tag;
        historyFilterEl.appendChild(opt);
      });
      if (tags.includes(currentValue)) {
        historyFilterEl.value = currentValue;
      }
    }

    const filtered = filterValue === 'all' ? list : list.filter((item) => item.tag === filterValue);

    // 목록에서 사라진 항목의 선택 상태는 정리
    const validIds = new Set(list.map((item) => item.id));
    Array.from(selectedHistoryIds).forEach((id) => {
      if (!validIds.has(id)) selectedHistoryIds.delete(id);
    });

    historyListEl.innerHTML = '';

    if (filtered.length === 0) {
      historyEmptyMessageEl.hidden = false;
      historySelectAllWrap.hidden = true;
      historyDeleteButton.disabled = true;
      return;
    }
    historyEmptyMessageEl.hidden = true;
    historySelectAllWrap.hidden = false;

    filtered.forEach((item) => {
      const li = document.createElement('li');
      li.className = 'history-item';
      li.innerHTML = `
        <input type="checkbox" class="history-item__select" data-id="${item.id}" ${selectedHistoryIds.has(item.id) ? 'checked' : ''} aria-label="이 분석 기록 선택">
        <div class="history-item__body">
          <div class="history-item__header">
            <span class="history-item__tag">${item.tag}</span>
            <span class="history-item__date">${formatDate(item.date)}</span>
          </div>
          <p class="history-item__preview">"${item.preview}"</p>
          <p class="history-item__result"><strong>🎯 의도</strong> ${item.intent}</p>
          <p class="history-item__result"><strong>💗 감정</strong> ${item.emotion}</p>
          <p class="history-item__result"><strong>🧭 목적</strong> ${item.purpose}</p>
          <p class="history-item__confidence">신뢰도 ${item.confidence}%</p>
        </div>
      `;
      historyListEl.appendChild(li);
    });

    updateHistoryControlsState();
  }

  function updateHistoryControlsState() {
    const checkboxes = Array.from(historyListEl.querySelectorAll('.history-item__select'));
    historyDeleteButton.disabled = !checkboxes.some((cb) => cb.checked);
    historySelectAllCheckbox.checked = checkboxes.length > 0 && checkboxes.every((cb) => cb.checked);
  }

  historyListEl.addEventListener('change', (e) => {
    if (!e.target.classList.contains('history-item__select')) return;
    const id = e.target.dataset.id;
    if (e.target.checked) {
      selectedHistoryIds.add(id);
    } else {
      selectedHistoryIds.delete(id);
    }
    updateHistoryControlsState();
  });

  if (historySelectAllCheckbox) {
    historySelectAllCheckbox.addEventListener('change', () => {
      const checkboxes = Array.from(historyListEl.querySelectorAll('.history-item__select'));
      checkboxes.forEach((cb) => {
        cb.checked = historySelectAllCheckbox.checked;
        if (cb.checked) {
          selectedHistoryIds.add(cb.dataset.id);
        } else {
          selectedHistoryIds.delete(cb.dataset.id);
        }
      });
      updateHistoryControlsState();
    });
  }

  if (historyDeleteButton) {
    historyDeleteButton.addEventListener('click', () => {
      if (selectedHistoryIds.size === 0) return;
      const count = selectedHistoryIds.size;
      if (!confirm(`선택한 ${count}개의 분석 기록을 삭제할까요?`)) return;

      const remaining = loadHistory().filter((item) => !selectedHistoryIds.has(item.id));
      persistHistory(remaining);
      selectedHistoryIds.clear();
      renderHistory();
    });
  }

  if (historyFilterEl) {
    historyFilterEl.addEventListener('change', () => {
      selectedHistoryIds.clear();
      renderHistory();
    });
  }

  /* ---------- Excel(CSV) 내보내기 ---------- */
  function exportHistoryToExcel() {
    const list = loadHistory();
    if (list.length === 0) {
      alert('내보낼 분석 기록이 없습니다.');
      return;
    }
    const header = ['날짜', '태그', '대화 미리보기', '숨은 의도', '감정', '목적', '신뢰도(%)'];
    const rows = list.map((item) => [
      formatDate(item.date),
      item.tag,
      item.preview.replace(/"/g, '""'),
      item.intent.replace(/"/g, '""'),
      item.emotion.replace(/"/g, '""'),
      item.purpose.replace(/"/g, '""'),
      item.confidence
    ]);

    const csvContent = [header, ...rows]
      .map((row) => row.map((cell) => `"${cell}"`).join(','))
      .join('\r\n');

    // 한글 깨짐 방지를 위한 UTF-8 BOM
    const blob = new Blob(['﻿' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mindread-history-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  if (historyExportButton) {
    historyExportButton.addEventListener('click', exportHistoryToExcel);
  }

  /* ---------- 초기 렌더 ---------- */
  document.addEventListener('DOMContentLoaded', renderHistory);
  if (document.readyState !== 'loading') {
    renderHistory();
  }
})();
