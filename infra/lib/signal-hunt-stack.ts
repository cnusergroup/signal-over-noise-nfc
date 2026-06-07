import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export class SignalHuntStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ========================================
    // Configuration (no secrets / account-specific values hardcoded)
    // Provide via CDK context (-c adminEmail=...) or environment variables.
    // ========================================
    const adminEmail: string =
      this.node.tryGetContext('adminEmail') ?? process.env.ADMIN_EMAIL ?? '';
    const certificateArn: string =
      this.node.tryGetContext('certificateArn') ?? process.env.CERTIFICATE_ARN ?? '';

    if (!adminEmail) {
      throw new Error(
        'Missing admin email. Pass it with `-c adminEmail=you@example.com` or set ADMIN_EMAIL.'
      );
    }
    if (!certificateArn) {
      throw new Error(
        'Missing ACM certificate ARN. Pass it with `-c certificateArn=arn:aws:acm:...` or set CERTIFICATE_ARN.'
      );
    }

    // ========================================
    // DynamoDB - Single-table design (pay-per-request)
    // ========================================
    const signalHuntTable = new dynamodb.Table(this, 'SignalHuntTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
    });

    // GSI1: Station traffic queries, mission lookups by type, tag mission entries
    signalHuntTable.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
    });

    // GSI2: Reserved for future access patterns
    signalHuntTable.addGlobalSecondaryIndex({
      indexName: 'GSI2',
      partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
    });

    // ========================================
    // Lambda - NFC Check-in Handler (handles all API routes)
    // ========================================
    const checkinHandler = new lambda.Function(this, 'CheckinHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('../lambda/checkin'),
      memorySize: 128,
      timeout: cdk.Duration.seconds(10),
      architecture: lambda.Architecture.ARM_64,
      environment: {
        TABLE_NAME: signalHuntTable.tableName,
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    // ========================================
    // Lambda - Lucky Draw Winner Selection (EventBridge triggered)
    // ========================================
    const luckyDrawHandler = new lambda.Function(this, 'LuckyDrawHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('../lambda/lucky-draw'),
      memorySize: 128,
      timeout: cdk.Duration.seconds(30),
      architecture: lambda.Architecture.ARM_64,
      environment: {
        TABLE_NAME: signalHuntTable.tableName,
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    // ========================================
    // Lambda - Last Call Finalization (EventBridge triggered)
    // ========================================
    const lastCallHandler = new lambda.Function(this, 'LastCallHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('../lambda/last-call'),
      memorySize: 128,
      timeout: cdk.Duration.seconds(30),
      architecture: lambda.Architecture.ARM_64,
      environment: {
        TABLE_NAME: signalHuntTable.tableName,
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    // Grant DynamoDB read/write to all Lambda functions
    signalHuntTable.grantReadWriteData(checkinHandler);
    signalHuntTable.grantReadWriteData(luckyDrawHandler);
    signalHuntTable.grantReadWriteData(lastCallHandler);

    // ========================================
    // EventBridge Scheduler IAM Role
    // ========================================
    const schedulerRole = new iam.Role(this, 'EventBridgeSchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description: 'Role for EventBridge Scheduler to invoke Lambda functions',
    });

    luckyDrawHandler.grantInvoke(schedulerRole);
    lastCallHandler.grantInvoke(schedulerRole);

    // Grant the check-in Lambda permission to create/manage EventBridge schedules
    checkinHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'scheduler:CreateSchedule',
        'scheduler:DeleteSchedule',
        'scheduler:GetSchedule',
        'scheduler:UpdateSchedule',
      ],
      resources: [`arn:aws:scheduler:${this.region}:${this.account}:schedule/default/*`],
    }));

    // Allow check-in Lambda to pass the scheduler role to EventBridge
    checkinHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: [schedulerRole.roleArn],
    }));

    // Add scheduler role ARN and Lambda ARNs to check-in handler environment
    checkinHandler.addEnvironment('SCHEDULER_ROLE_ARN', schedulerRole.roleArn);
    checkinHandler.addEnvironment('LUCKY_DRAW_LAMBDA_ARN', luckyDrawHandler.functionArn);
    checkinHandler.addEnvironment('LAST_CALL_LAMBDA_ARN', lastCallHandler.functionArn);

    // After Party Lottery time gate (ISO 8601 UTC)
    // Set to a past date so the lottery is always open for demo/testing.
    checkinHandler.addEnvironment('AFTER_PARTY_TIME_GATE', '2025-01-01T00:00:00Z');

    // ========================================
    // Cognito - Admin User Pool & JWT Authorizer
    // ========================================
    const userPool = new cognito.UserPool(this, 'AdminUserPool', {
      userPoolName: 'signal-hunt-admin-pool',
      signInAliases: { email: true },
      selfSignUpEnabled: false,
      passwordPolicy: { minLength: 8, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: false },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const userPoolClient = new cognito.UserPoolClient(this, 'AdminUserPoolClient', {
      userPool,
      userPoolClientName: 'signal-hunt-admin-client',
      authFlows: { userPassword: true, userSrp: true },
      generateSecret: false,
      // Keep users logged in for a week. Cognito caps ID/access tokens at 24h,
      // so the refresh token (7 days) is what keeps the session alive: the
      // client silently refreshes the short-lived tokens until it expires.
      refreshTokenValidity: cdk.Duration.days(7),
      idTokenValidity: cdk.Duration.hours(24),
      accessTokenValidity: cdk.Duration.hours(24),
    });

    const jwtAuthorizer = new HttpJwtAuthorizer('CognitoAuthorizer',
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      { jwtAudience: [userPoolClient.userPoolClientId] }
    );

    new cr.AwsCustomResource(this, 'CreateAdminUser', {
      onCreate: {
        service: 'CognitoIdentityServiceProvider',
        action: 'adminCreateUser',
        parameters: {
          UserPoolId: userPool.userPoolId,
          Username: adminEmail,
          UserAttributes: [
            { Name: 'email', Value: adminEmail },
            { Name: 'email_verified', Value: 'true' },
          ],
          MessageAction: 'SUPPRESS',
        },
        physicalResourceId: cr.PhysicalResourceId.of('admin-user-creation'),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [userPool.userPoolArn] }),
    });

    // Cognito Groups
    new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: userPool.userPoolId,
      groupName: 'admin',
      description: 'Full administrative access',
    });

    new cognito.CfnUserPoolGroup(this, 'ExhibitorGroup', {
      userPoolId: userPool.userPoolId,
      groupName: 'exhibitor',
      description: 'Exhibitor booth operators',
    });

    new cognito.CfnUserPoolGroup(this, 'StaffGroup', {
      userPoolId: userPool.userPoolId,
      groupName: 'staff',
      description: 'Event staff for verification',
    });

    new cr.AwsCustomResource(this, 'AddStationIdAttribute', {
      onCreate: {
        service: 'CognitoIdentityServiceProvider',
        action: 'addCustomAttributes',
        parameters: {
          UserPoolId: userPool.userPoolId,
          CustomAttributes: [{
            Name: 'stationId',
            AttributeDataType: 'String',
            Mutable: true,
            StringAttributeConstraints: { MinLength: '1', MaxLength: '2' },
          }],
        },
        physicalResourceId: cr.PhysicalResourceId.of('custom-attr-stationId'),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [userPool.userPoolArn] }),
    });

    // ========================================
    // API Gateway - HTTP API with full CORS support
    // ========================================
    const httpApi = new apigatewayv2.HttpApi(this, 'SignalHuntApi', {
      apiName: 'signal-hunt-api',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [
          apigatewayv2.CorsHttpMethod.GET,
          apigatewayv2.CorsHttpMethod.POST,
          apigatewayv2.CorsHttpMethod.PUT,
          apigatewayv2.CorsHttpMethod.DELETE,
          apigatewayv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    // Shared integration for the check-in handler
    const checkinIntegration = new integrations.HttpLambdaIntegration('CheckinIntegration', checkinHandler);

    // ========================================
    // Public Routes (no auth required)
    // ========================================

    // POST /checkin - NFC check-in
    httpApi.addRoutes({
      path: '/checkin',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: checkinIntegration,
    });

    // GET /checkin/{tagId} - Check-in progress query
    httpApi.addRoutes({
      path: '/checkin/{tagId}',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: checkinIntegration,
    });

    // GET /checkin/{tagId}/rewards - Rewards query (public)
    httpApi.addRoutes({
      path: '/checkin/{tagId}/rewards',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: checkinIntegration,
    });

    // GET /stations/{stationId} - Station traffic query
    httpApi.addRoutes({
      path: '/stations/{stationId}',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: checkinIntegration,
    });

    // GET /stations - Station summary
    httpApi.addRoutes({
      path: '/stations',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: checkinIntegration,
    });

    // GET /leaderboard - Speed challenge leaderboard
    httpApi.addRoutes({
      path: '/leaderboard',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: checkinIntegration,
    });

    // GET /missions/{missionId}/winners - Mission winners (public)
    httpApi.addRoutes({
      path: '/missions/{missionId}/winners',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: checkinIntegration,
    });

    // GET /missions/active - Active missions list (public)
    httpApi.addRoutes({
      path: '/missions/active',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: checkinIntegration,
    });

    // GET /combos - List combos (public)
    httpApi.addRoutes({
      path: '/combos',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: checkinIntegration,
    });

    // POST /lottery/nickname - Register lottery nickname (public; eligibility enforced in handler)
    httpApi.addRoutes({
      path: '/lottery/nickname',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: checkinIntegration,
    });

    // GET /lottery/participants - List lottery participants (public; consumed by lottery.html display)
    httpApi.addRoutes({
      path: '/lottery/participants',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: checkinIntegration,
    });

    // ========================================
    // Admin Routes (API key authorization required)
    // ========================================

    // POST /missions - Create mission
    httpApi.addRoutes({
      path: '/missions',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: checkinIntegration,
      authorizer: jwtAuthorizer,
    });

    // GET /missions - List missions (admin)
    httpApi.addRoutes({
      path: '/missions',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: checkinIntegration,
      authorizer: jwtAuthorizer,
    });

    // GET /missions/{missionId} - Get mission details
    httpApi.addRoutes({
      path: '/missions/{missionId}',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: checkinIntegration,
      authorizer: jwtAuthorizer,
    });

    // PUT /missions/{missionId} - Update mission
    httpApi.addRoutes({
      path: '/missions/{missionId}',
      methods: [apigatewayv2.HttpMethod.PUT],
      integration: checkinIntegration,
      authorizer: jwtAuthorizer,
    });

    // DELETE /missions/{missionId} - Delete mission
    httpApi.addRoutes({
      path: '/missions/{missionId}',
      methods: [apigatewayv2.HttpMethod.DELETE],
      integration: checkinIntegration,
      authorizer: jwtAuthorizer,
    });

    // POST /combos - Create combo (admin)
    httpApi.addRoutes({
      path: '/combos',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: checkinIntegration,
      authorizer: jwtAuthorizer,
    });

    // POST /rewards/redeem - Redeem a reward (admin auth)
    httpApi.addRoutes({
      path: '/rewards/redeem',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: checkinIntegration,
      authorizer: jwtAuthorizer,
    });

    // POST /verify/lunch - Staff verification (JWT required)
    httpApi.addRoutes({
      path: '/verify/lunch',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: checkinIntegration,
      authorizer: jwtAuthorizer,
    });

    // POST /verify/party - Staff verification (JWT required)
    httpApi.addRoutes({
      path: '/verify/party',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: checkinIntegration,
      authorizer: jwtAuthorizer,
    });

    // POST /entitlement/set - Set entitlement (JWT required)
    httpApi.addRoutes({
      path: '/entitlement/set',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: checkinIntegration,
      authorizer: jwtAuthorizer,
    });

    // POST /entitlement/remove - Remove entitlement (JWT required)
    httpApi.addRoutes({
      path: '/entitlement/remove',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: checkinIntegration,
      authorizer: jwtAuthorizer,
    });

    // GET /entitlement/{tagId} - Get entitlement status (JWT required)
    httpApi.addRoutes({
      path: '/entitlement/{tagId}',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: checkinIntegration,
      authorizer: jwtAuthorizer,
    });

    // POST /lottery/draw - Execute lottery draw (JWT required, admin group)
    httpApi.addRoutes({
      path: '/lottery/draw',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: checkinIntegration,
      authorizer: jwtAuthorizer,
    });

    // POST /lottery/winner - Manually add a winner by nickname (JWT required, admin group)
    httpApi.addRoutes({
      path: '/lottery/winner',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: checkinIntegration,
      authorizer: jwtAuthorizer,
    });

    // POST /lottery/participant - Manually add a candidate by nickname (JWT required, admin group)
    httpApi.addRoutes({
      path: '/lottery/participant',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: checkinIntegration,
      authorizer: jwtAuthorizer,
    });

    // GET /lottery/winners - List lottery winners (public — lottery display page polls this)
    httpApi.addRoutes({
      path: '/lottery/winners',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: checkinIntegration,
    });

    // GET /lottery/config - Read lottery settings (public)
    httpApi.addRoutes({
      path: '/lottery/config',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: checkinIntegration,
    });

    // POST /lottery/config - Save lottery settings (JWT required, admin group)
    httpApi.addRoutes({
      path: '/lottery/config',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: checkinIntegration,
      authorizer: jwtAuthorizer,
    });

    // POST /lottery/reset - Reset all lottery data (JWT required, admin group)
    httpApi.addRoutes({
      path: '/lottery/reset',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: checkinIntegration,
      authorizer: jwtAuthorizer,
    });

    // ========================================
    // S3 - Static website hosting
    // ========================================
    const websiteBucket = new s3.Bucket(this, 'WebsiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ========================================
    // CloudFront - CDN distribution
    // ========================================
    const certificate = cdk.aws_certificatemanager.Certificate.fromCertificateArn(
      this, 'CustomDomainCert',
      certificateArn
    );

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(websiteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.HttpOrigin(
            `${httpApi.httpApiId}.execute-api.${this.region}.amazonaws.com`
          ),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
      domainNames: ['2026-summer-events.awscommunityday.cn'],
      certificate,
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.minutes(5),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.minutes(5),
        },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    // ========================================
    // S3 Deployment - Upload static files
    // ========================================
    new s3deploy.BucketDeployment(this, 'DeployWebsite', {
      sources: [s3deploy.Source.asset('../', { exclude: ['infra/**', 'lambda/**', '.kiro/**', '.vscode/**', 'node_modules/**', '**/node_modules/**', '**/__tests__/**', '**/__mocks__/**', '**/*.test.mjs', '**/vitest.config.mjs'] })],
      destinationBucket: websiteBucket,
      distribution,
      distributionPaths: ['/*'],
    });

    // ========================================
    // Outputs
    // ========================================
    new cdk.CfnOutput(this, 'CloudFrontURL', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'CloudFront distribution URL',
    });

    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: httpApi.apiEndpoint,
      description: 'API Gateway endpoint',
    });

    new cdk.CfnOutput(this, 'TableName', {
      value: signalHuntTable.tableName,
      description: 'DynamoDB table name',
    });

    new cdk.CfnOutput(this, 'SchedulerRoleArn', {
      value: schedulerRole.roleArn,
      description: 'EventBridge Scheduler role ARN',
    });

    new cdk.CfnOutput(this, 'LuckyDrawLambdaArn', {
      value: luckyDrawHandler.functionArn,
      description: 'Lucky Draw Lambda function ARN',
    });

    new cdk.CfnOutput(this, 'LastCallLambdaArn', {
      value: lastCallHandler.functionArn,
      description: 'Last Call Lambda function ARN',
    });

    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
  }
}
