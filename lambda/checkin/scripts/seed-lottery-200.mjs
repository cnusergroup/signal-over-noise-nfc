#!/usr/bin/env node
/**
 * Seed N (default 200) lottery participants for visual testing of the sphere.
 * Writes NICKNAME#{nick}/RESERVED records (GSI1PK=NICKNAME_LIST) which is what
 * GET /lottery/participants reads.
 *
 * Usage (from lambda/checkin):
 *   TABLE_NAME=<table> node scripts/seed-lottery-200.mjs [count]
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

const TABLE = process.env.TABLE_NAME;
const REGION = process.env.AWS_REGION || 'ap-northeast-1';
const COUNT = parseInt(process.argv[2], 10) || 200;

if (!TABLE) { console.error('Error: TABLE_NAME env var required.'); process.exit(1); }

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

const ADJ = ['量子', '信号', '云端', '深度', '边缘', '反熵', '星际', '光年', '梯度', '分布式',
  '容器', '无服务', '数据', '智能', '混沌', '可观测', '零信任', '神经', '矢量', '拓扑',
  '湍流', '熵增', '相位', '谐振', '超导', '纠缠', '暗物质', '奇点', '虫洞', '曲率'];
const NOUN = ['比特', '猎人', '小王', '学习', '计算', '宇宙', '码农', '旅人', '下降', '梦想',
  '飞船', '架构', '湖畔', '体X', '工程', '性', '协议', '网络', '矩阵', '结构',
  '飞流', '之力', '空间', '频率', '风暴', '态', '使者', '边界', '通道', '之心'];

const now = new Date().toISOString();

function buildNicknames(n) {
  const set = new Set();
  let i = 0;
  while (set.size < n) {
    const a = ADJ[Math.floor(Math.random() * ADJ.length)];
    const b = NOUN[Math.floor(Math.random() * NOUN.length)];
    let name = a + b;
    if (set.has(name)) name = a + b + (++i);
    set.add(name);
  }
  return [...set];
}

async function seed() {
  const names = buildNicknames(COUNT);
  const items = names.map((nickname, idx) => ({
    PutRequest: {
      Item: {
        PK: `NICKNAME#${nickname}`,
        SK: 'RESERVED',
        GSI1PK: 'NICKNAME_LIST',
        GSI1SK: nickname,
        tagId: `test-tag-${idx + 1}`,
        nickname,
        registeredAt: now,
        test: true,
      },
    },
  }));

  console.log(`Seeding ${names.length} test participants into ${TABLE}...`);
  for (let i = 0; i < items.length; i += 25) {
    const batch = items.slice(i, i + 25);
    await client.send(new BatchWriteCommand({ RequestItems: { [TABLE]: batch } }));
    console.log(`  ${Math.min(i + 25, items.length)}/${items.length}`);
  }
  console.log('Done.');
}

seed().catch((e) => { console.error('Fatal:', e); process.exit(1); });
