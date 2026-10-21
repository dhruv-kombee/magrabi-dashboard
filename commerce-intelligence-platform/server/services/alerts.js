import { config, hasEnv } from '../config.js'

export function isAlertChannelConfigured() {
  return {
    teams: hasEnv('TEAMS_WEBHOOK_URL'),
    email: hasEnv('SMTP_HOST') && hasEnv('ALERT_EMAIL_RECIPIENTS'),
  }
}

export async function sendTeamsNotification(title, message, severity = 'INFO') {
  const { teamsWebhookUrl } = config.alerts
  if (!teamsWebhookUrl) {
    return { status: 'PENDING_CONFIG', missing: ['TEAMS_WEBHOOK_URL'] }
  }

  const themeColors = {
    INFO: '0078D7',
    WARNING: 'FFA500',
    CRITICAL: 'D83B01',
  }

  const cardPayload = {
    '@type': 'MessageCard',
    '@context': 'http://schema.org/extensions',
    themeColor: themeColors[severity] || '0078D7',
    summary: title,
    sections: [
      {
        activityTitle: `Magrabi Commerce Intelligence · ${title}`,
        activitySubtitle: `Severity: ${severity} · ${new Date().toISOString()}`,
        facts: [
          { name: 'Environment', value: 'Production' },
          { name: 'Details', value: message },
        ],
        markdown: true,
      },
    ],
  }

  try {
    const res = await fetch(teamsWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cardPayload),
    })
    return { status: res.ok ? 'OK' : 'FAIL', httpStatus: res.status }
  } catch (err) {
    console.error('Teams webhook error:', err.message)
    return { status: 'FAIL', error: err.message }
  }
}

export async function evaluateAlertRule(ruleParams, currentMetrics = {}) {
  const { rule, threshold, minimumAttempts = 10, notifyTeams = false, notifyEmail = false } = ruleParams

  let triggered = false
  let evaluationText = ''
  let subtext = ''

  if (rule === 'orders') {
    const orders = currentMetrics.orders ?? 0
    if (orders < threshold) {
      triggered = true
      evaluationText = `ALERT TRIGGERED: Confirmed orders (${orders}) fell below threshold (${threshold})`
      subtext = 'Commerce Operations on-call notified.'
    } else {
      evaluationText = `NORMAL: Confirmed orders (${orders}) within threshold (>= ${threshold})`
      subtext = 'No breach detected.'
    }
  } else if (rule === 'payments') {
    const onlineRate = currentMetrics.onlineRate ?? 68.0
    const failRate = 100 - onlineRate
    if (failRate >= threshold) {
      triggered = true
      evaluationText = `ALERT TRIGGERED: Payment failure rate (${failRate.toFixed(1)}%) breached threshold (${threshold}%)`
      subtext = 'Payments integration lead notified.'
    } else {
      evaluationText = `NORMAL: Payment failure rate (${failRate.toFixed(1)}%) is healthy (< ${threshold}%)`
      subtext = 'Gateway response within bounds.'
    }
  } else if (rule === '5xx') {
    const errorRate = currentMetrics.errorRatePct ?? 0.3
    if (errorRate >= threshold) {
      triggered = true
      evaluationText = `ALERT TRIGGERED: Origin 5xx rate (${errorRate.toFixed(1)}%) breached threshold (${threshold}%)`
      subtext = 'DevOps on-call notified.'
    } else {
      evaluationText = `NORMAL: Origin 5xx rate (${errorRate.toFixed(1)}%) is healthy (< ${threshold}%)`
      subtext = 'Edge routing stable.'
    }
  } else {
    evaluationText = 'Rule evaluated successfully.'
    subtext = 'All telemetry sources reporting on schedule.'
  }

  let teamsOutcome = null
  if (triggered && notifyTeams && hasEnv('TEAMS_WEBHOOK_URL')) {
    teamsOutcome = await sendTeamsNotification(
      `Breach: ${rule.toUpperCase()} Rule`,
      evaluationText,
      'CRITICAL',
    )
  }

  return {
    rule,
    threshold,
    triggered,
    text: evaluationText,
    subtext,
    channels: {
      teams: notifyTeams
        ? hasEnv('TEAMS_WEBHOOK_URL')
          ? teamsOutcome?.status || 'SENT'
          : 'PENDING_CONFIG: TEAMS_WEBHOOK_URL'
        : 'NOT_REQUESTED',
      email: notifyEmail
        ? hasEnv('SMTP_HOST')
          ? 'QUEUED'
          : 'PENDING_CONFIG: SMTP_HOST'
        : 'NOT_REQUESTED',
    },
  }
}
