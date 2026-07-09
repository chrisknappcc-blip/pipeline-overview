const TOKEN = process.env.HUBSPOT_PRIVATE_TOKEN;

const sleep = ms => new Promise(r => setTimeout(r, ms));

const PIPELINES = {
  '679336808': 'Opportunity',
  '678610513': 'Deal',
  '679502246': 'Expansion',
};

const EXCLUDED_STAGES = [
  '1347324753', // Opportunity: Closed/Lost
  '1331037807', // Opportunity: Meeting Completed - Not A Fit
  '995756100',  // Deal: Closed - Lost
  '995749999',  // Deal: Closed - Won   (pulled separately)
  '995750000',  // Deal: Revisit
  '995723927',  // Expansion: Closed Lost
  '995739776',  // Expansion: Closed Won (pulled separately)
  '1004627778', // Expansion: Revisit
];

const WON_STAGE_IDS = [
  '995749999',  // Deal: Closed - Won
  '995739776',  // Expansion: Closed Won
];

const DEAL_PROPERTIES = [
  'dealname', 'pipeline', 'dealstage', 'amount',
  'amount_in_home_currency', 'closedate', 'hubspot_owner_id',
  'implementation_fee__c', 'annual_recurring_fee__c',
  'acv__c', 'service_percent',
];

async function fetchPage(filterGroups, after = undefined, attempt = 0) {
  const body = {
    filterGroups,
    properties: DEAL_PROPERTIES,
    limit: 200,
    sorts: [{ propertyName: 'closedate', direction: 'DESCENDING' }],
  };
  if (after) body.after = after;

  const res = await fetch('https://api.hubapi.com/crm/v3/objects/deals/search', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  // Retry on 429 with exponential backoff (max 3 attempts)
  if (res.status === 429 && attempt < 3) {
    await sleep(1000 * Math.pow(2, attempt)); // 1s, 2s, 4s
    return fetchPage(filterGroups, after, attempt + 1);
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`HubSpot API error ${res.status}: ${err}`);
  }
  return res.json();
}

async function fetchPipelineDeals(pipelineId) {
  const filterGroups = [{
    filters: [
      { propertyName: 'pipeline', operator: 'EQ', value: pipelineId },
      { propertyName: 'dealstage', operator: 'NOT_IN', values: EXCLUDED_STAGES },
    ],
  }];

  const deals = [];
  let after = undefined;
  while (true) {
    const data = await fetchPage(filterGroups, after);
    deals.push(...data.results);
    if (data.paging?.next?.after && deals.length < data.total) {
      after = data.paging.next.after;
    } else break;
  }
  return deals;
}

async function fetchClosedWonDeals() {
  // Fetch all closed/won deals across all three pipelines using hs_is_closed_won
  const filterGroups = [{
    filters: [
      { propertyName: 'hs_is_closed_won', operator: 'EQ', value: 'true' },
      { propertyName: 'pipeline', operator: 'IN', values: Object.keys(PIPELINES) },
    ],
  }];

  const deals = [];
  let after = undefined;
  while (true) {
    const data = await fetchPage(filterGroups, after);
    deals.push(...data.results);
    if (data.paging?.next?.after && deals.length < data.total) {
      after = data.paging.next.after;
    } else break;
  }
  return deals;
}

function mapDeal(d, won = false) {
  return {
    id:        d.id,
    pipeline:  d.properties.pipeline,
    dealname:  d.properties.dealname || '(Unnamed)',
    dealstage: d.properties.dealstage,
    amount:    parseFloat(d.properties.amount_in_home_currency || 0),
    closedate: (d.properties.closedate || '').slice(0, 10),
    owner:     d.properties.hubspot_owner_id || '',
    impl:      parseFloat(d.properties.implementation_fee__c   || 0),
    recur:     parseFloat(d.properties.annual_recurring_fee__c || 0),
    acv:       parseFloat(d.properties.acv__c                  || 0),
    svc:       parseFloat(d.properties.service_percent         || 0),
    won,
  };
}

exports.handler = async () => {
  if (!TOKEN) {
    return { statusCode: 500, body: JSON.stringify({ error: 'HUBSPOT_PRIVATE_TOKEN not set' }) };
  }

  try {
    // Sequential with 350ms gaps to stay under HubSpot's search rate limit
    const oppDeals = await fetchPipelineDeals('679336808');
    await sleep(350);
    const dealDeals = await fetchPipelineDeals('678610513');
    await sleep(350);
    const expDeals = await fetchPipelineDeals('679502246');
    await sleep(350);
    const wonRaw = await fetchClosedWonDeals();

    const allDeals = [...oppDeals, ...dealDeals, ...expDeals].map(d => mapDeal(d, false));
    const wonDeals = wonRaw.map(d => mapDeal(d, true));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        deals: allDeals,
        wonDeals,
        fetchedAt: new Date().toISOString(),
        counts: {
          opportunity: oppDeals.length,
          deal:        dealDeals.length,
          expansion:   expDeals.length,
          total:       allDeals.length,
          won:         wonDeals.length,
        },
      }),
    };
  } catch (err) {
    console.error('pipeline-data error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
