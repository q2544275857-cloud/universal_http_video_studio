import { summarizeRemoteTask } from '../server/provider/creativeStudioI2V.js';
import { remoteFailureRetryDecision } from '../server/lifecycleService.js';

const policy = summarizeRemoteTask({
  id: 'draft_policy',
  taskId: 'remote_policy',
  draftTaskStatus: 0,
  error_code: 10043300,
  video_url: 'https://example.com/rejected.mp4'
});

const technical = summarizeRemoteTask({
  id: 'draft_tech',
  taskId: 'remote_tech',
  draftTaskStatus: 'failed',
  error_message: 'Temporary internal service unavailable, try again'
});

const policyDecision = remoteFailureRetryDecision(policy, 0, 3);
const technicalDecision = remoteFailureRetryDecision(technical, 0, 3);

const result = {
  policy: {
    ready: policy.ready,
    failed: policy.failed,
    errorCode: policy.errorCode,
    shouldRetry: policyDecision.shouldRetry,
    policyOrModeration: policyDecision.policyOrModeration
  },
  technical: {
    ready: technical.ready,
    failed: technical.failed,
    shouldRetry: technicalDecision.shouldRetry,
    technicalRetryable: technicalDecision.technicalRetryable
  }
};

const ok = result.policy.ready === false
  && result.policy.failed === true
  && result.policy.errorCode === '10043300'
  && result.policy.shouldRetry === false
  && result.policy.policyOrModeration === true
  && result.technical.failed === true
  && result.technical.shouldRetry === true;

console.log(JSON.stringify({ ok, ...result }, null, 2));
if (!ok) process.exitCode = 1;
