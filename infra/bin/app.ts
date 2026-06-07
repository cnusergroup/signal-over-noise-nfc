#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { SignalHuntStack } from '../lib/signal-hunt-stack';

const app = new cdk.App();

new SignalHuntStack(app, 'SignalHuntStack', {
  description: 'Signal Over Noise - NFC Check-in Infrastructure',
});

app.synth();
