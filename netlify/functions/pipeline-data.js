const TOKEN = process.env.HUBSPOT_PRIVATE_TOKEN;

const PIPELINES = {
  '679336808': 'Opportunity',
  '678610513': 'Deal',
  '679502246': 'Expansion',
};

const EXCLUDED_STAGES = [
  '1347324753', // Opportunity: Closed/Lost
  '1331037807', // Opportunity: Meeting Completed - Not A Fit
  '995756100',  // Deal: Closed - Lost
  '995749999',  // Deal: Closed - Won
  '995750000',  // Deal: Revisit
  '995723927',  // Expansion: Closed Lost
  '995739776',  // Expansion: Closed Won
  '1004627778', // Expansion: Revisit
];

async function fetchPage(filterGroups, after = undefined) {
  const body = {
    filterGroups,
    properties: [
      'dealname', 'pipeline', 'dealstage', 'amount',
      'amount_in_home_currency', 'closedate', 'hubspot_owner_id',
    ],
    limit: 200,
    sorts: [{ propertyName: 'amount_in_home_currency', direction: 'DESCENDING' }],
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

  // Paginate — HubSpot caps search at 10,000 results, offset at 10,000
  while (true) {
    const data = await fetchPage(filterGroups, after);
    deals.push(...data.results);

    if (data.paging?.next?.after && deals.length < data.total) {
      after = data.paging.next.after;
    } else {
      break;
    }
  }

  return deals;
}

exports.handler = async () => {
  if (!TOKEN) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'HUBSPOT_PRIVATE_TOKEN not set' }),
    };
  }

  try {
    // Fetch all three pipelines in parallel
    const [oppDeals, dealDeals, expDeals] = await Promise.all([
      fetchPipelineDeals('679336808'),
      fetchPipelineDeals('678610513'),
      fetchPipelineDeals('679502246'),
    ]);

    const allDeals = [...oppDeals, ...dealDeals, ...expDeals].map(d => ({
      id: d.id,
      pipeline: d.properties.pipeline,
      dealname: d.properties.dealname || '(Unnamed)',
      dealstage: d.properties.dealstage,
      amount: parseFloat(d.properties.amount_in_home_currency || 0),
      closedate: (d.properties.closedate || '').slice(0, 10),
      owner: d.properties.hubspot_owner_id || '',
    }));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify({
        deals: allDeals,
        fetchedAt: new Date().toISOString(),
        counts: {
          opportunity: oppDeals.length,
          deal: dealDeals.length,
          expansion: expDeals.length,
          total: allDeals.length,
        },
      }),
    };
  } catch (err) {
    console.error('pipeline-data error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
