export interface AlmanacConfig {
  projectName: string;
  environment: string;
  region: string;
  dynamodb: {
    holidaysTable: string;
    timezonesTable: string;
    billingMode: 'PAY_PER_REQUEST' | 'PROVISIONED';
  };
  s3: {
    rawBucket: string;
    stagingBucket: string;
    validatedBucket: string;
    archiveBucket: string;
    glueScriptsBucket: string;
  };
  glue: {
    databaseName: string;
    crawlerName: string;
  };
  monitoring: {
    logRetentionDays: number;
    enableXRay: boolean;
  };
  security?: {
    enableWAF: boolean;
  };
  tags: {
    [key: string]: string;
  };
}

export function getConfig(environment: string): AlmanacConfig {
  const projectName = 'almanac-api';
  
  const baseConfig: AlmanacConfig = {
    projectName,
    environment,
    region: 'ap-south-1',
    dynamodb: {
      holidaysTable: `${projectName}-${environment}-holidays`,
      timezonesTable: `${projectName}-${environment}-timezones`,
      billingMode: 'PAY_PER_REQUEST',
    },
    s3: {
      rawBucket: `${projectName}-${environment}-raw`,
      stagingBucket: `${projectName}-${environment}-staging`,
      validatedBucket: `${projectName}-${environment}-validated`,
      archiveBucket: `${projectName}-${environment}-archive`,
      glueScriptsBucket: `${projectName}-${environment}-glue-scripts`,
    },
    glue: {
      databaseName: `${projectName}_${environment}_db`,
      crawlerName: `${projectName}-${environment}-crawler`,
    },
    monitoring: {
      logRetentionDays: environment === 'prod' ? 90 : 30,
      enableXRay: true,
    },
    security: {
      enableWAF: environment === 'prod',
    },
    tags: {
      Project: projectName,
      Environment: environment,
      ManagedBy: 'CDK',
      CostCenter: 'Engineering',
    },
  };

  // Environment-specific overrides
  if (environment === 'prod') {
    baseConfig.monitoring.logRetentionDays = 90;
  }

  return baseConfig;
}