(function attachGraphModel(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MyScholarGraphModel = api;
})(typeof window !== 'undefined' ? window : globalThis, function createGraphModel() {
  'use strict';

  const DEFAULT_SIMILARITY_THRESHOLD = 0;
  const DEFAULT_TOP_K = 2;
  const FIELD_WEIGHTS = Object.freeze({ title: 3, abstract: 1, keywords: 3, researchTopics: 3 });
  const READING_STATUS_COLORS = Object.freeze({
    '未开始': '#8b95a7',
    '阅读中': '#e79a3b',
    '已完成': '#4f9f7f',
  });
  const ATTRIBUTE_COLORS = Object.freeze({
    research_topic: '#8c72d8',
    venue: '#5f91c9',
    folders: '#c99349',
    authors: '#4f9f7f',
    year: '#81889a',
    custom: '#a56fae',
  });
  const ENGLISH_STOPWORDS = new Set((
    'a an and are as at be been being but by can could did do does doing for from had has have having ' +
    'he her hers him his how i if in into is it its itself may might more most must no nor not of on once ' +
    'only or other our ours out over own same she should so some such than that the their theirs them then ' +
    'there these they this those through to too under up very was we were what when where which while who why ' +
    'will with would you your yours also based between both each et etc paper propose proposed presents present ' +
    'show shows shown method methods approach approaches result results study studies using use used via new'
  ).split(/\s+/));

  function cleanText(value) {
    const text = String(value == null ? '' : value);
    const normalized = typeof text.normalize === 'function' ? text.normalize('NFKC') : text;
    return normalized.replace(/\s+/g, ' ').trim();
  }

  function canonicalValue(value) {
    return cleanText(value).toLowerCase();
  }

  function toStrings(value) {
    const values = Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
    return values.map(cleanText).filter(Boolean);
  }

  function clampNumber(value, minimum, maximum, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
  }

  function unique(values) {
    return [...new Set(values)];
  }

  function normalizeVenue(value) {
    let venue = cleanText(value).replace(/^[,;:\s]+|[,;:\s]+$/g, '');
    if (!venue) return '';
    const lower = venue.toLowerCase();
    const families = [
      [/(?:advances\s+in\s+)?neural\s+information\s+processing\s+systems|\bneurips\b|\bnips\b/, 'NeurIPS'],
      [/computer\s+vision\s+and\s+pattern\s+recognition|\bcvpr\b/, 'CVPR'],
      [/international\s+conference\s+on\s+machine\s+learning|\bicml\b/, 'ICML'],
      [/international\s+conference\s+on\s+learning\s+representations|\biclr\b/, 'ICLR'],
      [/international\s+conference\s+on\s+computer\s+vision|\biccv\b/, 'ICCV'],
      [/european\s+conference\s+on\s+computer\s+vision|\beccv\b/, 'ECCV'],
      [/association\s+for\s+computational\s+linguistics|\bacl\b/, 'ACL'],
      [/empirical\s+methods\s+in\s+natural\s+language\s+processing|\bemnlp\b/, 'EMNLP'],
      [/transactions\s+on\s+machine\s+learning\s+research|\btmlr\b/, 'TMLR'],
      [/journal\s+of\s+machine\s+learning\s+research|\bjmlr\b/, 'JMLR'],
      [/^arxiv(?:\b|[-:])/, 'arXiv'],
    ];
    for (const [pattern, label] of families) {
      if (pattern.test(lower)) return label;
    }

    venue = venue
      .replace(/^(?:19|20)\d{2}\s+/, '')
      .replace(/^proceedings\s+of\s+(?:the\s+)?(?:\d+(?:st|nd|rd|th)\s+)?/i, '')
      .replace(/[,\s]+(?:19|20)\d{2}$/, '')
      .trim();
    const acronym = venue.match(/\(([A-Za-z][A-Za-z0-9.+&/-]{1,11})\)\s*$/);
    return acronym ? acronym[1] : venue;
  }

  function tokenize(value) {
    const normalized = cleanText(value).toLowerCase();
    if (!normalized) return [];
    const tokens = [];
    for (const match of normalized.matchAll(/[a-z0-9]+(?:[._+-][a-z0-9]+)*/g)) {
      const token = match[0];
      if (token.length > 1 && !/^\d+$/.test(token) && !ENGLISH_STOPWORDS.has(token)) tokens.push(token);
    }
    for (const match of normalized.matchAll(/[\u3400-\u4dbf\u4e00-\u9fff]+/g)) {
      const sequence = [...match[0]];
      for (let index = 0; index + 1 < sequence.length; index += 1) tokens.push(sequence[index] + sequence[index + 1]);
    }
    return tokens;
  }

  function weightedTerms(document) {
    const terms = new Map();
    const fields = [
      [document.title, FIELD_WEIGHTS.title],
      [document.abstract, FIELD_WEIGHTS.abstract],
      [toStrings(document.keywords).join(' '), FIELD_WEIGHTS.keywords],
      [toStrings(document.researchTopics).join(' '), FIELD_WEIGHTS.researchTopics],
    ];
    for (const [text, weight] of fields) {
      const tokens = tokenize(text);
      if (!tokens.length) continue;
      const counts = new Map();
      for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
      for (const [token, count] of counts) {
        terms.set(token, (terms.get(token) || 0) + weight * (1 + Math.log(count)));
      }
    }
    return terms;
  }

  function similarityDocument(paper, index) {
    const data = paper && paper.data ? paper.data : paper || {};
    const id = cleanText(data.id || `paper:${data.jobId || index}`);
    return {
      id,
      jobId: cleanText(data.jobId || id.replace(/^paper:/, '')),
      title: cleanText(data.title || data.label),
      abstract: cleanText(data.abstract),
      keywords: toStrings(data.keywords),
      researchTopics: toStrings(data.researchTopics || data.topics),
    };
  }

  function computeSimilarityEdges(papers, config = {}) {
    const documents = (Array.isArray(papers) ? papers : []).map(similarityDocument).filter((document) => document.id);
    const topK = Math.max(0, Math.floor(clampNumber(config.topK, 0, 100, DEFAULT_TOP_K)));
    const configuredThreshold = clampNumber(config.similarityThreshold, 0, 1, DEFAULT_SIMILARITY_THRESHOLD);
    const termFrequencies = documents.map(weightedTerms);
    const documentFrequency = new Map();
    for (const terms of termFrequencies) {
      for (const token of terms.keys()) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    }
    const vectors = termFrequencies.map((terms) => {
      const vector = new Map();
      let squaredNorm = 0;
      for (const [token, frequency] of terms) {
        const inverseDocumentFrequency = Math.log((documents.length + 1) / ((documentFrequency.get(token) || 0) + 1)) + 1;
        const value = frequency * inverseDocumentFrequency;
        vector.set(token, value);
        squaredNorm += value * value;
      }
      return { values: vector, norm: Math.sqrt(squaredNorm) };
    });

    const pairs = [];
    for (let leftIndex = 0; leftIndex < documents.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < documents.length; rightIndex += 1) {
        const left = vectors[leftIndex];
        const right = vectors[rightIndex];
        if (!left.norm || !right.norm) continue;
        const [smaller, larger] = left.values.size <= right.values.size ? [left.values, right.values] : [right.values, left.values];
        let dotProduct = 0;
        const contributions = [];
        for (const [token, leftValue] of smaller) {
          const rightValue = larger.get(token);
          if (!rightValue) continue;
          const contribution = leftValue * rightValue;
          dotProduct += contribution;
          contributions.push({ token, contribution });
        }
        if (!dotProduct) continue;
        const score = dotProduct / (left.norm * right.norm);
        if (!(score > 0)) continue;
        const sharedTokens = contributions
          .sort((leftContribution, rightContribution) => rightContribution.contribution - leftContribution.contribution || leftContribution.token.localeCompare(rightContribution.token))
          .slice(0, 5)
          .map((entry) => entry.token);
        pairs.push({ left: documents[leftIndex], right: documents[rightIndex], score, sharedTokens });
      }
    }

    const effectiveThreshold = configuredThreshold;
    pairs.sort((left, right) => right.score - left.score || left.left.id.localeCompare(right.left.id) || left.right.id.localeCompare(right.right.id));
    const degree = new Map(documents.map((document) => [document.id, 0]));
    const edges = [];
    for (const pair of pairs) {
      if (pair.score + Number.EPSILON < effectiveThreshold) continue;
      if ((degree.get(pair.left.id) || 0) >= topK || (degree.get(pair.right.id) || 0) >= topK) continue;
      const [source, target] = pair.left.id.localeCompare(pair.right.id) <= 0
        ? [pair.left.id, pair.right.id]
        : [pair.right.id, pair.left.id];
      const score = Number(pair.score.toFixed(6));
      edges.push({
        data: {
          id: `edge:similarity:${encodeURIComponent(source)}:${encodeURIComponent(target)}`,
          type: 'similarity',
          kind: 'similarity',
          source,
          target,
          label: '内容相似',
          score,
          strength: score,
          sharedTokens: pair.sharedTokens,
          reasons: pair.sharedTokens.map((token) => `共同内容词：${token}`),
        },
      });
      degree.set(pair.left.id, (degree.get(pair.left.id) || 0) + 1);
      degree.set(pair.right.id, (degree.get(pair.right.id) || 0) + 1);
    }
    return {
      edges,
      effectiveThreshold: Number(effectiveThreshold.toFixed(6)),
      nonzeroPairCount: pairs.length,
    };
  }

  function librarySnapshot(snapshot) {
    return snapshot && snapshot.library && snapshot.library.items ? snapshot.library : snapshot || {};
  }

  function metadataFields(item) {
    if (item && item.metadata && item.metadata.fields && typeof item.metadata.fields === 'object') return item.metadata.fields;
    return item && item.metadata && typeof item.metadata === 'object' ? item.metadata : {};
  }

  function jobMapFor(snapshot, config) {
    const jobs = [];
    if (Array.isArray(snapshot && snapshot.jobs)) jobs.push(...snapshot.jobs);
    if (Array.isArray(config.jobs)) jobs.push(...config.jobs);
    return new Map(jobs.filter((job) => job && job.job_id).map((job) => [String(job.job_id), job]));
  }

  function paperRecords(snapshot, config) {
    const library = librarySnapshot(snapshot);
    const jobs = jobMapFor(snapshot, config);
    return Object.entries(library.items || {}).flatMap(([jobId, rawItem]) => {
      const item = rawItem && typeof rawItem === 'object' ? rawItem : {};
      if (item.deleted_at) return [];
      const metadata = metadataFields(item);
      const values = item.values && typeof item.values === 'object' ? item.values : {};
      const job = jobs.get(String(jobId)) || item.job || {};
      const sourceFilename = cleanText(job.source_filename);
      const title = cleanText(metadata.title || sourceFilename.replace(/\.pdf$/i, '') || '未命名文献');
      const authors = unique(toStrings(metadata.authors));
      const keywords = unique(toStrings(metadata.keywords));
      const researchTopics = unique(toStrings(values.research_topic));
      const rawVenue = cleanText(values.venue || metadata.venue || metadata.conference_name || metadata.publication_title || metadata.proceedings_title || metadata.repository);
      const venue = normalizeVenue(rawVenue);
      const numericYear = Number(metadata.year);
      const year = Number.isInteger(numericYear) && numericYear >= 1000 && numericYear <= 3000 ? numericYear : null;
      const readingStatus = cleanText(values.reading_status || '未开始');
      const importance = Math.round(clampNumber(values.importance, 0, 5, 0));
      const id = `paper:${jobId}`;
      const statusColor = READING_STATUS_COLORS[readingStatus] || READING_STATUS_COLORS['未开始'];
      const data = {
        id,
        type: 'paper',
        kind: 'paper',
        jobId: String(jobId),
        label: title,
        title,
        sourceFilename,
        authors,
        abstract: cleanText(metadata.abstract),
        keywords,
        researchTopics,
        year,
        rawVenue,
        venue,
        readingStatus,
        importance,
        size: 31 + importance,
        statusColor,
        color: statusColor,
        folderIds: unique(toStrings(item.folder_ids)),
      };
      data.searchText = [title, authors.join(' '), venue, researchTopics.join(' '), keywords.join(' ')].filter(Boolean).join(' ').toLowerCase();
      return [{ id, item, metadata, values, data, node: { data } }];
    });
  }

  function normalizeConfig(library, config) {
    const properties = Array.isArray(library.properties) ? library.properties : [];
    const defaultAttributeIds = [
      'research_topic',
      'venue',
      ...properties
        .filter((property) => property && !property.system && !property.hidden && ['select', 'multi-select'].includes(property.type))
        .map((property) => String(property.id)),
    ];
    return {
      showSimilarity: config.showSimilarity !== false && config.includeSimilarity !== false,
      showAttributes: config.showAttributes !== false && config.includeAttributes !== false,
      attributeIds: unique((Array.isArray(config.attributeIds) ? config.attributeIds : defaultAttributeIds).map(cleanText).filter(Boolean)),
      similarityThreshold: clampNumber(config.similarityThreshold, 0, 1, DEFAULT_SIMILARITY_THRESHOLD),
      topK: Math.max(0, Math.floor(clampNumber(config.topK, 0, 100, DEFAULT_TOP_K))),
    };
  }

  function attributeDefinitions(library, attributeIds) {
    const properties = new Map((Array.isArray(library.properties) ? library.properties : [])
      .filter((property) => property && property.id)
      .map((property) => [String(property.id), property]));
    const special = {
      research_topic: { id: 'research_topic', label: '研究主题', type: 'multi-select', color: ATTRIBUTE_COLORS.research_topic },
      venue: { id: 'venue', label: '接收/来源', type: 'venue', color: ATTRIBUTE_COLORS.venue },
      folders: { id: 'folders', label: '文件夹', type: 'folders', color: ATTRIBUTE_COLORS.folders },
      authors: { id: 'authors', label: '作者', type: 'authors', color: ATTRIBUTE_COLORS.authors },
      year: { id: 'year', label: '年份', type: 'year', color: ATTRIBUTE_COLORS.year },
    };
    return attributeIds.flatMap((id) => {
      if (special[id]) return [special[id]];
      const property = properties.get(id);
      if (!property || !['select', 'multi-select', 'text', 'rating'].includes(property.type)) return [];
      return [{
        id,
        label: cleanText(property.label || id),
        type: property.type,
        color: ATTRIBUTE_COLORS.custom,
      }];
    });
  }

  function valuesForAttribute(record, definition, folders) {
    if (definition.id === 'venue') return record.data.venue ? [record.data.venue] : [];
    if (definition.id === 'authors') return record.data.authors;
    if (definition.id === 'year') return record.data.year == null ? [] : [String(record.data.year)];
    if (definition.id === 'folders') {
      return record.data.folderIds.map((folderId) => folders.get(folderId)).filter(Boolean).map((folder) => cleanText(folder.name));
    }
    if (definition.type === 'rating') {
      const rating = Number(record.values[definition.id]);
      return Number.isFinite(rating) && rating > 0 ? [`${Math.round(rating)} 星`] : [];
    }
    if (definition.type === 'text') {
      const value = cleanText(record.values[definition.id]);
      return value && [...value].length <= 80 ? [value] : [];
    }
    return toStrings(record.values[definition.id]);
  }

  function attributeNodeId(propertyId, value) {
    return `attribute:${encodeURIComponent(propertyId)}:${encodeURIComponent(canonicalValue(value))}`;
  }

  function buildAttributeGraph(records, library, config) {
    if (!config.showAttributes) return { nodes: [], edges: [] };
    const definitions = attributeDefinitions(library, config.attributeIds);
    const folders = new Map((Array.isArray(library.folders) ? library.folders : [])
      .filter((folder) => folder && folder.id && !folder.system)
      .map((folder) => [String(folder.id), folder]));
    const attributeStates = new Map();
    const edges = [];
    for (const record of records) {
      for (const definition of definitions) {
        const seen = new Set();
        for (const rawValue of valuesForAttribute(record, definition, folders)) {
          const value = definition.id === 'venue' ? normalizeVenue(rawValue) : cleanText(rawValue);
          if (!value) continue;
          const nodeId = attributeNodeId(definition.id, value);
          if (seen.has(nodeId)) continue;
          seen.add(nodeId);
          if (!attributeStates.has(nodeId)) {
            attributeStates.set(nodeId, {
              data: {
                id: nodeId,
                type: 'attribute',
                kind: definition.id,
                attributeKind: definition.id,
                propertyId: definition.id,
                propertyLabel: definition.label,
                propertyType: definition.type,
                label: value,
                value,
                paperCount: 0,
                paperIds: [],
                jobIds: [],
                size: 38,
                color: definition.color,
                searchText: `${definition.label} ${value}`.toLowerCase(),
              },
              paperIds: new Set(),
              jobIds: new Set(),
            });
          }
          const attribute = attributeStates.get(nodeId);
          attribute.paperIds.add(record.id);
          attribute.jobIds.add(record.data.jobId);
          edges.push({
            data: {
              id: `edge:property:${encodeURIComponent(record.id)}:${encodeURIComponent(nodeId)}`,
              type: 'property',
              kind: 'property',
              source: record.id,
              target: nodeId,
              label: definition.label,
              propertyId: definition.id,
              propertyLabel: definition.label,
              value,
              reasons: [`${definition.label}：${value}`],
            },
          });
        }
      }
    }
    const nodes = [...attributeStates.values()].map((state) => {
      state.data.paperIds = [...state.paperIds];
      state.data.jobIds = [...state.jobIds];
      state.data.paperCount = state.paperIds.size;
      return { data: state.data };
    });
    return { nodes, edges };
  }

  function buildGraph(snapshot, rawConfig = {}) {
    const library = librarySnapshot(snapshot);
    const config = normalizeConfig(library, rawConfig || {});
    const records = paperRecords(snapshot, rawConfig || {});
    const attributeGraph = buildAttributeGraph(records, library, config);
    const similarity = config.showSimilarity
      ? computeSimilarityEdges(records.map((record) => record.node), config)
      : { edges: [], effectiveThreshold: config.similarityThreshold, nonzeroPairCount: 0 };
    const nodes = [...records.map((record) => record.node), ...attributeGraph.nodes];
    const edges = [...attributeGraph.edges, ...similarity.edges];
    return {
      nodes,
      edges,
      stats: {
        paperCount: records.length,
        attributeCount: attributeGraph.nodes.length,
        propertyEdgeCount: attributeGraph.edges.length,
        similarityEdgeCount: similarity.edges.length,
        effectiveThreshold: similarity.effectiveThreshold,
        nonzeroSimilarityPairCount: similarity.nonzeroPairCount,
      },
      config: { ...config },
    };
  }

  return Object.freeze({
    buildGraph,
    computeSimilarityEdges,
    normalizeVenue,
    tokenize,
    constants: Object.freeze({
      DEFAULT_SIMILARITY_THRESHOLD,
      DEFAULT_TOP_K,
      FIELD_WEIGHTS,
      READING_STATUS_COLORS,
    }),
  });
});
