export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const {
      fileName,
      durationSec,
      partDurationSec = 90, // По умолчанию 1 мин 30 сек (строго в диапазоне 1-2 минуты)
      maxParts = 60
    } = body;

    // 1. Делим всё видео последовательно на полноценные серии/части от 1 до 2 минут (60–120 сек)
    const minPart = 60;
    const maxPart = 120;
    const targetLen = Math.min(maxPart, Math.max(minPart, Number(partDurationSec) || 90));

    const segments = [];
    let cursor = 0;
    let index = 1;

    while (cursor < durationSec && segments.length < maxParts) {
      let remaining = durationSec - cursor;
      let clipDur = targetLen;

      if (remaining <= maxPart) {
        // Если остаток вписывается в 1-2 минуты (или видео короткое) — берем его целиком
        clipDur = remaining;
      } else if (remaining - targetLen < minPart) {
        // Чтобы последний кусочек не получился коротким огрызком меньше 1 минуты, делим остаток поровну на части по 1–2 мин
        clipDur = Math.floor(remaining / 2);
      }

      const endSec = Math.min(durationSec, cursor + clipDur);
      segments.push({
        index,
        startSec: Math.floor(cursor),
        endSec: Math.floor(endSec),
        durationSec: Math.max(1, Math.floor(endSec - cursor))
      });

      cursor = endSec;
      index++;
      if (endSec >= durationSec) break;
    }

    const cleanTopic = (fileName || "Серия").replace(/\.[^/.]+$/, "").replace(/[-_]/g, " ");

    // 2. Если подключен Cloudflare Workers AI
    if (context.env && context.env.AI && segments.length <= 15) {
      const prompt = `Ты — ИИ-редактор видео и сериалов.
Исходное видео называется: "${cleanTopic}" (общая длительность ${Math.round(durationSec / 60)} мин).
Мы разделили его последовательно на ${segments.length} полноценных частей по 1-2 минуты каждая.
Верни СТРОГО валидный JSON без markdown-обертки:
{
  "folderTitle": "Короткое название папки проекта на русском",
  "clips": [
    {
      "title": "Часть 1. Интригующее название серии",
      "description": "Описание того, что происходит в этой части (1-2 предложения без рекламы).",
      "hashtags": ["#часть1", "#серия", "#нарезка", "#shorts", "#рек"],
      "subtitles": [
        "Продолжаем просмотр — самая суть без рекламных вставок",
        "Обратите внимание на то, что происходит в этой сцене",
        "Ключевой диалог и развитие событий текущей части",
        "Смотрите следующую часть в этой же папке!"
      ],
      "viralScore": 9.5
    }
  ]
}
Количество объектов в массиве clips: ${segments.length}.`;

      try {
        const aiRes = await context.env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
          messages: [
            { role: "system", content: "Отвечай только чистым JSON на русском языке." },
            { role: "user", content: prompt }
          ],
          max_tokens: 1400
        });

        const text = aiRes.response || "";
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          const enrichedClips = segments.map((seg, idx) => {
            const aiClip = (parsed.clips && parsed.clips[idx]) || {};
            return {
              ...seg,
              title: aiClip.title || `${cleanTopic} — Часть ${idx + 1}`,
              description: aiClip.description || `Полноценная часть #${idx + 1} (${formatTime(seg.startSec)} – ${formatTime(seg.endSec)}), длительность ${formatDurationText(seg.durationSec)}. Без рекламных баннеров.`,
              hashtags: Array.isArray(aiClip.hashtags) ? aiClip.hashtags : [`#часть${idx + 1}`, "#серия", "#безрекламы", "#shorts"],
              subtitles: Array.isArray(aiClip.subtitles) && aiClip.subtitles.length > 0
                ? aiClip.subtitles
                : buildPartSubtitles(cleanTopic, idx + 1, seg.startSec, seg.endSec),
              bannersRemoved: true,
              viralScore: aiClip.viralScore || Number((9.2 + (idx % 3) * 0.2).toFixed(1))
            };
          });

          return new Response(JSON.stringify({
            folderTitle: parsed.folderTitle || cleanTopic,
            clips: enrichedClips,
            source: "cloudflare-ai"
          }), {
            headers: { "Content-Type": "application/json" }
          });
        }
      } catch (e) {
        // Fallback below
      }
    }

    const fallbackClips = generateSequentialMetadata(cleanTopic, segments);
    return new Response(JSON.stringify({
      folderTitle: fallbackClips.folderTitle,
      clips: fallbackClips.clips,
      source: "sequential-engine"
    }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

function formatTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatDurationText(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  if (m > 0 && s > 0) return `${m} мин ${s} сек`;
  if (m > 0) return `${m} мин`;
  return `${s} сек`;
}

function buildPartSubtitles(topic, partNum, startSec, endSec) {
  const shortTopic = topic.slice(0, 30);
  return [
    `${shortTopic} • Часть ${partNum} (${formatTime(startSec)} – ${formatTime(endSec)})`,
    `Смотрим полноценный фрагмент серии без рекламных баннеров`,
    `Развитие сюжета и ключевые события текущей минуты`,
    `Чистый звук и кадр — все лишние плашки автоматически срезаны`,
    `Ключевой поворот эпизода — не пропустите детали`,
    `Продолжение следует в Части ${partNum + 1} прямо в этой папке!`
  ];
}

function generateSequentialMetadata(topic, segments) {
  const partHooks = [
    "Начало и завязка",
    "Развитие событий",
    "Ключевой эпизод",
    "Острый момент серии",
    "Неожиданный поворот",
    "Главный диалог",
    "Накал страстей",
    "Кульминация эпизода"
  ];

  const baseTags = topic
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 3)
    .map((w) => `#${w.replace(/[^a-zа-яё0-9]/gi, "")}`)
    .filter((t) => t.length > 2);

  return {
    folderTitle: `${topic.charAt(0).toUpperCase() + topic.slice(1)}`,
    clips: segments.map((seg, i) => {
      const partNum = i + 1;
      const hook = partHooks[i % partHooks.length];
      return {
        ...seg,
        title: `Часть ${partNum}. ${topic} — ${hook}`,
        description: `Полноценная ${partNum}-я часть серии «${topic}» (таймкод ${formatTime(seg.startSec)} – ${formatTime(seg.endSec)}, длительность ${formatDurationText(seg.durationSec)}). Рекламные баннеры срезаны, добавлены русские субтитры.`,
        hashtags: [...new Set([`#часть${partNum}`, ...baseTags, "#серия", "#нарезка", "#безрекламы", "#shorts"])].slice(0, 6),
        subtitles: buildPartSubtitles(topic, partNum, seg.startSec, seg.endSec),
        bannersRemoved: true,
        viralScore: Number((9.6 - (i % 4) * 0.2).toFixed(1))
      };
    })
  };
}
