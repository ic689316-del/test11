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
  function extractOtherLine(text) {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const last = lines.length ? lines[lines.length - 1] : text.trim();
    const stripped = last.replace(/^[^\s:：]{1,12}\s*[:：]\s*/, '').trim();
    return stripped || text.trim();
  }

  function shortQuote(line, max) {
    const limit = max || 22;
    const t = line.replace(/["""]/g, '').trim();
    return t.length > limit ? `${t.slice(0, limit)}…` : t;
  }

  /* ---------- 의도/감정/목적 판별 규칙 ---------- */
  // replies는 고정 문장이 아니라 실제 상대방 말(line)을 받아서 그 자리에서 답을 만들어내는 함수.
  // 그래야 매번 같은 3문장이 아니라 입력한 대화에 맞는 답변이 나온다.
  const INTENT_RULES = [
    {
      tone: 'distancing',
      keywords: ['다음에', '나중에', '바쁘', '됐어', '괜찮아 안 해도', '아니야 괜찮'],
      intent: '갈등 없이 완곡하게 거리를 두거나 거절하려는 것',
      purpose: '직접 거절해서 관계가 어색해지는 상황을 피하려는 것',
      emotion: '무심함 속에 약간의 부담·서운함',
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
      keywords: ['혹시', '괜찮으면', '시간 되면', '가능하면', '부탁'],
      intent: '거절당할 부담 없이 조심스럽게 요청하거나 제안하려는 것',
      purpose: '직접적으로 요구하기보다 상대가 편하게 응할 여지를 남기려는 것',
      emotion: '기대감과 조심스러움이 섞인 상태',
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
      keywords: ['요즘 어때', '잘 지내', '별일 없', '어떻게 지내', '분위기 어때'],
      intent: '가볍게 안부를 묻는 척하며 실제로는 상태나 분위기를 살피려는 것',
      purpose: '민감한 주제를 직접 묻기 전에 상대의 반응이나 근황을 먼저 탐색하려는 것',
      emotion: '궁금함과 약간의 경계심',
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
      keywords: ['확인', '체크', '보고', '왜', '진행 상황', '언제까지'],
      intent: '책임 소재를 확인하거나 진행 상황을 평가하려는 것',
      purpose: '업무나 상황에 대한 통제권을 확보하고 리스크를 미리 점검하려는 것',
      emotion: '긴장감과 압박감',
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
      keywords: ['미안', '죄송', '내 잘못', '오해', '화해'],
      intent: '갈등을 빨리 진정시키고 관계를 회복하려는 것',
      purpose: '긴장된 관계를 완화하고 다시 좋은 분위기로 되돌리려는 것',
      emotion: '미안함과 조심스러움',
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
      keywords: ['보고싶', '연락해', '같이 가자', '데이트', '좋아해'],
      intent: '호감이나 친밀감을 은근히 드러내며 반응을 살피려는 것',
      purpose: '직접 고백하기 전에 상대의 관심 정도를 확인하려는 것',
      emotion: '설렘과 동시에 거절에 대한 불안',
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
    intent: '표면적인 말과는 다른 속마음이 담겨 있을 가능성이 높은 것',
    purpose: '직접적으로 드러내기 조심스러운 감정이나 요구가 있는 것',
    emotion: '겉으로 드러나지 않는 복합적인 감정',
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
      keywords: ['싫어', '가기 싫', '안 하고 싶', '못 하겠어', '하기 싫', '별로'],
      suggestions: [
        '그날 컨디션이 좀 안 좋을 것 같아서, 이번엔 참석이 어려울 것 같아요.',
        '다른 일정이 겹칠 것 같은데, 다음 기회에 함께해도 될까요?',
        '요즘 좀 바빠서 이번엔 힘들 것 같아요, 다음엔 꼭 챙길게요.'
      ]
    },
    {
      tone: 'request',
      keywords: ['해줘', '부탁', '도와줘', '필요해', '도움'],
      suggestions: [
        '혹시 시간 괜찮으시면 이 부분 한번 봐주실 수 있을까요?',
        '바쁘시면 나중에 여유 되실 때 알려주셔도 괜찮아요.',
        '죄송한데 급하게 부탁 하나만 드려도 될까요?'
      ]
    },
    {
      tone: 'complaint',
      keywords: ['서운', '섭섭', '화나', '짜증', '불만'],
      suggestions: [
        '그때 좀 아쉬웠던 것 같아요, 다음엔 이렇게 해주시면 좋을 것 같아요.',
        '혹시 그렇게 하신 데는 이유가 있으셨을까요?',
        '별건 아닌데, 그 부분은 조금만 더 신경 써주시면 좋겠어요.'
      ]
    },
    {
      tone: 'affection',
      keywords: ['좋아해', '만나고 싶', '데이트', '보고 싶'],
      suggestions: [
        '요즘 자주 생각나네, 우리 언제 한번 시간 맞춰서 볼까?',
        '혹시 다음에 같이 밥 한번 먹지 않을래?',
        '너랑 있으면 편한 것 같아, 앞으로도 자주 보고 싶어.'
      ]
    },
    {
      tone: 'question',
      keywords: ['왜 그랬', '진짜야', '맞아?', '사실이야'],
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
      '문장 앞에 "혹시"나 "괜찮으시면"을 붙이면 훨씬 부드러워져요.',
      '"~것 같아요"처럼 단정짓지 않는 말투로 바꿔보면 어때요?',
      '이유를 짧게 한마디 덧붙이면 오해 없이 부드럽게 전달할 수 있어요.'
    ]
  };

  const TAG_CONTEXT = {
    '직장·모임': '직장 내 관계이므로 위계나 평가에 대한 부담이 섞여 있을 수 있어요.',
    '연인·가족': '가까운 사이일수록 돌려 말하는 표현 속에 애정이나 서운함이 함께 담겨 있을 수 있어요.',
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
      const score = rule.keywords.reduce((acc, kw) => acc + (text.includes(kw) ? kw.length : 0), 0);
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

  function detectEmotionHint(text, rule) {
    const hasPositive = POSITIVE_WORDS.some((w) => text.includes(w));
    const hasNegative = NEGATIVE_WORDS.some((w) => text.includes(w));
    if (hasPositive && !hasNegative) return `${rule.emotion} (표면적으로는 긍정적인 표현도 함께 보여요)`;
    if (hasNegative && !hasPositive) return `${rule.emotion} (부정적인 감정 단서도 함께 드러나요)`;
    return rule.emotion;
  }

  function calcConfidence(text, rule) {
    const matchedCount = rule.keywords ? rule.keywords.filter((kw) => text.includes(kw)).length : 0;
    const lengthBonus = Math.min(text.trim().length / 20, 10);
    let confidence = 58 + matchedCount * 9 + lengthBonus;
    confidence += Math.floor(Math.random() * 6); // 자연스러운 변주
    return Math.max(55, Math.min(97, Math.round(confidence)));
  }

  function analyzeConversation(text, tag) {
    const rule = matchRule(text);
    const context = tag && TAG_CONTEXT[tag] ? TAG_CONTEXT[tag] : '';
    const purpose = context ? `${rule.purpose}. ${context}` : rule.purpose;
    const otherLine = extractOtherLine(text);

    return {
      intent: rule.intent,
      emotion: detectEmotionHint(text, rule),
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
    const text = conversationInput.value.trim();
    if (!text) {
      alert('분석할 대화 내용을 입력해주세요.');
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

  /* ---------- 나도 숨은 의도로 물어보기 ---------- */
  const askButton = document.getElementById('ask-button');
  const askInput = document.getElementById('ask-input');
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
      askResultList.hidden = false;
      askResultList.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

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

    historyListEl.innerHTML = '';

    if (filtered.length === 0) {
      historyEmptyMessageEl.hidden = false;
      return;
    }
    historyEmptyMessageEl.hidden = true;

    filtered.forEach((item) => {
      const li = document.createElement('li');
      li.className = 'history-item';
      li.innerHTML = `
        <div class="history-item__header">
          <span class="history-item__tag">${item.tag}</span>
          <span class="history-item__date">${formatDate(item.date)}</span>
        </div>
        <p class="history-item__preview">"${item.preview}"</p>
        <p class="history-item__result"><strong>🎯 의도</strong> ${item.intent}</p>
        <p class="history-item__result"><strong>💗 감정</strong> ${item.emotion}</p>
        <p class="history-item__result"><strong>🧭 목적</strong> ${item.purpose}</p>
        <p class="history-item__confidence">신뢰도 ${item.confidence}%</p>
      `;
      historyListEl.appendChild(li);
    });
  }

  if (historyFilterEl) {
    historyFilterEl.addEventListener('change', renderHistory);
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
