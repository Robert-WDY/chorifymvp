// Test receipts validate wiring only; never manufacture production quality evidence.
export function simulationEvidence(item,executions,artifacts){
 const coverage=item.coverage||item.resolvedCoverage;
 if(!coverage)return {checker:'test_stub',scope:'receipt_mapping',planningCoverage:'not_applicable',receiptMapping:'not_applicable',visualQuality:'not_evaluated'};
 const records=executions.filter(e=>e.itemId===item.id),wanted=coverage.layout==='storyboard_sheet'?[coverage.unitIds]:coverage.unitIds.map(id=>[id]);
 const mapping=records.length===wanted.length&&wanted.every(ids=>records.some(e=>JSON.stringify(e.coverage?.unitIds)===JSON.stringify(ids)&&JSON.stringify(e.coverage?.source)===JSON.stringify(coverage.source)&&e.status==='succeeded'&&artifacts.some(a=>a.sourceExecutionId===e.id&&a.metadata?.simulated&&a.url&&JSON.stringify(a.metadata.coverage?.unitIds)===JSON.stringify(ids))));
 return {checker:'test_stub',scope:'receipt_mapping',planningCoverage:wanted.length===item.count?'passed':'failed',receiptMapping:mapping?'passed':'failed',visualQuality:'not_evaluated',productionAcceptance:false};
}
