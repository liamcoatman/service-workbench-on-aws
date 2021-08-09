/*
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License").
 *  You may not use this file except in compliance with the License.
 *  A copy of the License is located at
 *
 *  http://aws.amazon.com/apache2.0
 *
 *  or in the "license" file accompanying this file. This file is distributed
 *  on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either
 *  express or implied. See the License for the specific language governing
 *  permissions and limitations under the License.
 */
const _ = require('lodash');
const uuid = require('uuid');
const { runAndCatch } = require('@aws-ee/base-services/lib/helpers/utils');
const Service = require('@aws-ee/base-services-container/lib/service');
const { isAdmin } = require('@aws-ee/base-services/lib/authorization/authorization-utils');
const createSchema = require('../schema/create-egress-store.json');
const {
  getStatementParamsFn,
  listStatementParamsFn,
  putStatementParamsFn,
  updateS3BucketPolicy,
  addAccountToStatement,
  getRevisedS3Statements,
  removeAccountFromStatement,
} = require('../helpers/utils');

const settingKeys = {
  tableName: 'dbEgressStore',
  enableEgressStore: 'enableEgressStore',
  egressStoreBucketName: 'egressStoreBucketName',
  egressNotificationBucketName: 'egressNotificationBucketName',
  egressStoreKmsKeyAliasArn: 'egressStoreKmsKeyAliasArn',
  egressNotificationSnsTopicArn: 'egressNotificationSnsTopicArn',
};

const PROCESSING_STATUS_CODE = 'PROCESSING';
const PROCESSED_STATUS_CODE = 'PROCESSED';
const TERMINATED_STATUS_CODE = 'TERMINATED';
const CREATED_STATUS_CODE = 'CREATED';
// use pending status code when egress request is send to Data Manager
const PENDING_STATUS_CODE = 'PENDING';
class DataEgressService extends Service {
  constructor() {
    super();
    this.dependency([
      'aws',
      'jsonSchemaValidationService',
      'dbService',
      'auditWriterService',
      's3Service',
      'environmentScService',
      'lockService',
    ]);
  }

  async init() {
    await super.init();
    const [dbService] = await this.service(['dbService']);
    const table = this.settings.get(settingKeys.tableName);

    this._getter = () => dbService.helper.getter().table(table);
    this._query = () => dbService.helper.query().table(table);
    this._updater = () => dbService.helper.updater().table(table);
    this._deleter = () => dbService.helper.deleter().table(table);
    this._scanner = () => dbService.helper.scanner().table(table);
  }

  async getEgressStoreInfo(environmentId) {
    const workspaceId = environmentId;
    let egressStoreScanResult = [];

    try {
      egressStoreScanResult = await this._scanner()
        .limit(1000)
        .scan()
        .then(egressStores => {
          return egressStores.filter(store => store.workspaceId === workspaceId);
        });
    } catch (error) {
      throw this.boom.notFound(`Error in fetch egress store info: ${JSON.stringify(error)}`, true);
    }

    if (egressStoreScanResult.length === 0) {
      return null;
    }
    if (egressStoreScanResult.length !== 1) {
      throw this.boom.internalError(
        `Error in getting egress store info: multiple results fetched from egrss store table`,
        true,
      );
    }
    return egressStoreScanResult[0];
  }

  async createEgressStore(requestContext, environment) {
    const enableEgressStore = this.settings.get(settingKeys.enableEgressStore);
    const by = _.get(requestContext, 'principalIdentifier.uid');

    if (!enableEgressStore || enableEgressStore.toUpperCase() !== 'TRUE') {
      throw this.boom.forbidden('Unable to create Egress store since this feature is disabled', true);
    }

    const [validationService, s3Service] = await this.service(['jsonSchemaValidationService', 's3Service']);
    await validationService.ensureValid(environment, createSchema);

    const bucketName = this.settings.get(settingKeys.egressStoreBucketName);
    const folderName = `${environment.id}/`;

    try {
      s3Service.createPath(bucketName, folderName);
    } catch (error) {
      throw this.boom.badRequest(`Error in creating egress store:${folderName} in bucket: ${bucketName}`, true);
    }

    // prepare info for ddb and update egress store info
    const egressStoreId = environment.id;
    const creationTime = new Date().toISOString;
    const dbObject = {
      id: egressStoreId,
      egressStoreName: `${environment.name}-egress-store`,
      createdAt: creationTime,
      createdBy: environment.createdBy,
      workspaceId: environment.id,
      projectId: environment.projectId,
      s3BucketName: bucketName,
      s3BucketPath: folderName,
      status: CREATED_STATUS_CODE,
      updatedBy: by,
      updatedAt: creationTime,
      ver: 0,
      isAbleToSubmitEgressRequest: false,
      egressStoreObjectListLocation: null,
    };

    const lockService = await this.service('lockService');
    const egressStoreDdbLockId = `egress-store-ddb-access-${egressStoreId}`;
    await lockService.tryWriteLockAndRun({ id: egressStoreDdbLockId }, async () => {
      await runAndCatch(
        async () => {
          return this._updater()
            .condition('attribute_not_exists(id)') // yes we need this to ensure the egress store does not exist already
            .key({ id: egressStoreId })
            .item(dbObject)
            .update();
        },
        async () => {
          throw this.boom.badRequest(`Egress Store with id "${egressStoreId}" already exists`, true);
        },
      );
    });

    const kmsArn = await this.getKmsKeyIdArn();
    // Prepare egress store info for updating S3 bucket policy
    const egressStore = {
      id: `egress-store-${environment.id}`,
      readable: true,
      writeable: true,
      kmsArn,
      bucket: bucketName,
      prefix: folderName,
      envPermission: {
        read: true,
        write: true,
      },
      status: 'reachable',
      createdBy: environment.createdBy,
      workspaceId: environment.id,
      projectId: environment.projectId,
      resources: [
        {
          arn: `arn:aws:s3:::${bucketName}/${environment.id}/`,
        },
      ],
    };
    const memberAccountId = await this.getMemberAccountId(requestContext, environment.id);

    const bucketPolicyLockId = `bucket-policy-access-${bucketName}`;
    await lockService.tryWriteLockAndRun({ id: bucketPolicyLockId }, async () => {
      await this.addEgressStoreBucketPolicy(requestContext, egressStore, memberAccountId);
    });

    return egressStore;
  }

  async terminateEgressStore(requestContext, environmentId) {
    const enableEgressStore = this.settings.get(settingKeys.enableEgressStore);
    const curUser = _.get(requestContext, 'principalIdentifier.uid');
    if (!enableEgressStore || enableEgressStore.toUpperCase() !== 'TRUE') {
      throw this.boom.forbidden('Unable to terminate Egress store since this feature is disabled', true);
    }

    const egressStoreInfo = await this.getEgressStoreInfo(environmentId);
    if (!egressStoreInfo) {
      await this.audit(requestContext, {
        action: 'terminated-egress-store',
        body: 'No egress store found to be terminated',
      });
      return null;
    }
    const isEgressStoreOwner = egressStoreInfo.createdBy === curUser;
    if (!isAdmin(requestContext) && !isEgressStoreOwner) {
      throw this.boom.forbidden(
        `You are not authorized to terminate the egress store. Please contact your administrator.`,
        true,
      );
    }

    const s3Service = await this.service('s3Service');
    const egressStoreStatus = egressStoreInfo.status;
    const isEgressStoreNotTouched =
      egressStoreStatus.toUpperCase() === CREATED_STATUS_CODE && egressStoreInfo.isAbleToSubmitEgressRequest === false;

    if (egressStoreStatus.toUpperCase() === PROCESSING_STATUS_CODE) {
      throw this.boom.forbidden(
        `Egress store: ${egressStoreInfo.id} is still in processing. The egress store is not terminated and the workspce can not be terminated before egress request is processed.`,
        true,
      );
    } else if (egressStoreStatus.toUpperCase() === PROCESSED_STATUS_CODE || isEgressStoreNotTouched) {
      // ONLY terminate the egress store if it has been processed or the egress store is empty

      try {
        await s3Service.clearPath(egressStoreInfo.s3BucketName, egressStoreInfo.s3BucketPath);
      } catch (error) {
        throw this.boom.badRequest(
          `Error in deleting egress store:${egressStoreInfo.s3BucketName} in bucket: ${egressStoreInfo.s3BucketPath}`,
          true,
        );
      }

      const lockService = await this.service('lockService');
      const egressStoreDdbLockId = `egress-store-ddb-access-${egressStoreInfo.id}`;
      egressStoreInfo.status = TERMINATED_STATUS_CODE;
      egressStoreInfo.updatedBy = curUser;
      egressStoreInfo.updatedAt = new Date().toISOString();
      egressStoreInfo.isAbleToSubmitEgressRequest = false;
      await this.lockAndUpdate(egressStoreDdbLockId, egressStoreInfo.id, egressStoreInfo);

      const egressStore = {
        id: `egress-store-${environmentId}`,
        readable: true,
        writeable: true,
        bucket: egressStoreInfo.s3BucketName,
        prefix: egressStoreInfo.s3BucketPath,
        envPermission: {
          read: true,
          write: true,
        },
        status: 'reachable',
        createdBy: egressStoreInfo.createdBy,
        workspaceId: environmentId,
        projectId: egressStoreInfo.projectId,
        resources: [
          {
            arn: `arn:aws:s3:::${egressStoreInfo.s3BucketName}/${environmentId}/`,
          },
        ],
      };

      // Remove egress store related s3 policy from the s3 bucket
      const memberAccountId = await this.getMemberAccountId(requestContext, environmentId);

      const lockId = `bucket-policy-access-${egressStoreInfo.s3BucketName}`;
      await lockService.tryWriteLockAndRun({ id: lockId }, async () => {
        await this.removeEgressStoreBucketPolicy(requestContext, egressStore, memberAccountId);
      });
      await this.audit(requestContext, {
        action: 'terminated-egress-store',
        body: egressStore,
      });
    }
    return egressStoreInfo;
  }

  async getEgressStore(requestContext, environmentId) {
    const enableEgressStore = this.settings.get(settingKeys.enableEgressStore);
    if (!enableEgressStore || enableEgressStore.toUpperCase() !== 'TRUE') {
      throw this.boom.forbidden('Unable to list objects in egress store since this feature is disabled', true);
    }
    const curUser = _.get(requestContext, 'principalIdentifier.uid');
    const egressStoreInfo = await this.getEgressStoreInfo(environmentId);
    const isEgressStoreOwner = egressStoreInfo.createdBy === curUser;
    if (!isAdmin(requestContext) && !isEgressStoreOwner) {
      throw this.boom.forbidden(
        `You are not authorized to perform egress store list. Please contact your administrator for more information.`,
        true,
      );
    }
    const s3Service = await this.service('s3Service');
    // always fetch all the objects and sort and return top 100
    const objectList = await s3Service.listAllObjects({
      Bucket: egressStoreInfo.s3BucketName,
      Prefix: egressStoreInfo.s3BucketPath,
    });
    objectList.sort((a, b) => {
      return new Date(a.LastModified) - new Date(b.LastModified);
    });
    let result = [];
    _.forEach(objectList, obj => {
      obj.projectId = egressStoreInfo.projectId;
      obj.workspaceId = egressStoreInfo.workspaceId;
      obj.Size = this.bytesToSize(obj.Size);
      const newKey = obj.Key.split('/');
      if (newKey[1]) {
        obj.Key = newKey[1];
        result.push(obj);
      }
    });
    if (result.length > 100) {
      result = result.slice(0, 100);
    }

    return { objectList: result, isAbleToSubmitEgressRequest: egressStoreInfo.isAbleToSubmitEgressRequest };
  }

  bytesToSize(bytes) {
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
    if (bytes === 0) return '0 Byte';
    let i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)), 10); // parseInt(string, radix) string: The value to parse. radix: An integer between 2 and 36 that represents the radix of the string.
    i = i <= 5 ? i : 5;
    return `${Math.round(bytes / 1024 ** i, 2)} ${sizes[i]}`;
  }

  async prepareEgressStoreSnapshot(egressStoreInfo) {
    const s3Service = await this.service('s3Service');
    const egressNotificationBucketName = this.settings.get(settingKeys.egressNotificationBucketName);
    const curVersion = parseInt(egressStoreInfo.ver, 10) + 1; // parseInt(string, radix) string: The value to parse. radix: An integer between 2 and 36 that represents the radix of the string.
    const key = `${egressStoreInfo.id}/${egressStoreInfo.egressStoreName}-ver${curVersion}.json`;
    try {
      const objectList = await s3Service.listAllObjects({
        Bucket: egressStoreInfo.s3BucketName,
        Prefix: egressStoreInfo.s3BucketPath,
      });
      await Promise.all(
        _.map(objectList, async obj => {
          const latestVersion = await s3Service.getLatestObjectVersion({
            Bucket: egressStoreInfo.s3BucketName,
            Prefix: obj.Key,
          });
          obj.VersionId = latestVersion.VersionId;
          obj.Owner = latestVersion.Owner;
          return obj;
        }),
      );
      const params = {
        Bucket: egressNotificationBucketName,
        Key: key,
        Body: JSON.stringify({ objects: objectList }),
        ContentType: 'application/json',
      };
      await s3Service.putObject(params);
    } catch (error) {
      throw this.boom.badRequest(
        `Error in preparing EgressStoreSnapshot, bucket:${egressNotificationBucketName}, key: ${key}`,
        true,
      );
    }
    return { bucket: egressNotificationBucketName, key };
  }

  async notifySNS(requestContext, environmentId) {
    const enableEgressStore = this.settings.get(settingKeys.enableEgressStore);
    const curUser = _.get(requestContext, 'principalIdentifier.uid');
    if (!enableEgressStore || enableEgressStore.toUpperCase() !== 'TRUE') {
      throw this.boom.forbidden('Unable to create Egress store since this feature is disabled', true);
    }

    const egressStoreInfo = await this.getEgressStoreInfo(environmentId);
    if (!egressStoreInfo.isAbleToSubmitEgressRequest) {
      throw this.boom.badRequest(
        `Egress Store:${egressStoreInfo.id} is not ready for egress. Please contact your administrator for more information.`,
        true,
      );
    }
    const isEgressStoreOwner = egressStoreInfo.createdBy === curUser;
    if (!isAdmin(requestContext) && !isEgressStoreOwner) {
      throw this.boom.forbidden(
        `You are not authorized to submit egress request. Please contact your administrator for more information.`,
        true,
      );
    }
    const egressStoreObjectList = await this.prepareEgressStoreSnapshot(egressStoreInfo);

    // update dynamodb info
    const egressStoreDdbLockId = `egress-store-ddb-access-${egressStoreInfo.id}`;
    if (egressStoreInfo.status.toUpperCase() !== PENDING_STATUS_CODE) {
      egressStoreInfo.status = PENDING_STATUS_CODE;
    }
    egressStoreInfo.updatedBy = curUser;
    egressStoreInfo.updatedAt = new Date().toISOString();
    egressStoreInfo.isAbleToSubmitEgressRequest = false;
    egressStoreInfo.egressStoreObjectListLocation = `arn:aws:s3:::${egressStoreObjectList.bucket}/${egressStoreObjectList.key}`;
    egressStoreInfo.ver = parseInt(egressStoreInfo.ver, 10) + 1; // parseInt(string, radix) string: The value to parse. radix: An integer between 2 and 36 that represents the radix of the string.
    await this.lockAndUpdate(egressStoreDdbLockId, egressStoreInfo.id, egressStoreInfo);

    const message = {
      egressStoreObjectListLocation: `arn:aws:s3:::${egressStoreObjectList.bucket}/${egressStoreObjectList.key}`,
      id: uuid.v4(),
      egress_store_id: egressStoreInfo.id,
      egress_store_name: egressStoreInfo.egressStoreName,
      created_at: egressStoreInfo.createdAt,
      created_by: egressStoreInfo.createdBy,
      workspace_id: egressStoreInfo.workspaceId,
      project_id: egressStoreInfo.projectId,
      s3_bucketname: egressStoreInfo.s3BucketName,
      s3_bucketpath: egressStoreInfo.s3BucketPath,
      status: egressStoreInfo.status,
      updated_by: egressStoreInfo.updatedBy,
      updated_at: egressStoreInfo.updatedAt,
      ver: egressStoreInfo.ver,
    };

    // publish the message to SNS
    try {
      await this.publishMessage(JSON.stringify(message));
    } catch (error) {
      throw this.boom.badRequest(`Unable to publish message for egress store: ${egressStoreInfo.id}`, true);
    }

    // Write audit
    await this.audit(requestContext, { action: 'trigger-egress-notification-process', body: message });
    return message;
  }

  async audit(requestContext, auditEvent) {
    const auditWriterService = await this.service('auditWriterService');
    // Calling "writeAndForget" instead of "write" to allow main call to continue without waiting for audit logging
    // and not fail main call if audit writing fails for some reason
    // If the main call also needs to fail in case writing to any audit destination fails then switch to "write" method as follows
    // return auditWriterService.write(requestContext, auditEvent);
    return auditWriterService.writeAndForget(requestContext, auditEvent);
  }

  // @private
  async getKmsKeyIdArn() {
    // Get the kms key id
    const kmsAliasArn = this.settings.get(settingKeys.egressStoreKmsKeyAliasArn);

    // Get KMS Key ARN from KMS Alias ARN
    // The "Decrypt","DescribeKey","GenerateDataKey" etc require KMS KEY ARN and not ALIAS ARN
    const kmsClient = await this.getKMS();
    const data = await kmsClient
      .describeKey({
        KeyId: kmsAliasArn,
      })
      .promise();
    return data.KeyMetadata.Arn;
  }

  async getKMS() {
    const aws = await this.getAWS();
    return new aws.sdk.KMS();
  }

  async getAWS() {
    const aws = await this.service('aws');
    return aws;
  }

  async getS3() {
    const aws = await this.getAWS();
    return new aws.sdk.S3();
  }

  async publishMessage(message) {
    const aws = await this.getAWS();
    const snsService = new aws.sdk.SNS();
    const topicArn = this.settings.get(settingKeys.egressNotificationSnsTopicArn);
    const params = { Message: message, TopicArn: topicArn };
    await snsService.publish(params).promise();
  }

  async getS3BucketAndPolicy() {
    const s3BucketName = this.settings.get(settingKeys.egressStoreBucketName);
    const s3Client = await this.getS3();
    const s3Policy = JSON.parse((await s3Client.getBucketPolicy({ Bucket: s3BucketName }).promise()).Policy);
    if (!s3Policy.Statement) {
      s3Policy.Statement = [];
    }
    return { s3BucketName, s3Policy };
  }

  async addEgressStoreBucketPolicy(requestContext, egressStore, memberAccountId) {
    const { s3BucketName, s3Policy } = await this.getS3BucketAndPolicy();

    const statementParamFunctions = [];
    if (egressStore.envPermission.read) {
      statementParamFunctions.push(getStatementParamsFn);
    }
    if (egressStore.envPermission.write) {
      statementParamFunctions.push(putStatementParamsFn);
    }
    if (egressStore.envPermission.read || egressStore.envPermission.write) {
      statementParamFunctions.push(listStatementParamsFn);
    }
    const revisedStatements = await getRevisedS3Statements(
      s3Policy,
      egressStore,
      s3BucketName,
      statementParamFunctions,
      oldStatement => addAccountToStatement(oldStatement, memberAccountId),
    );

    const s3Client = await this.getS3();

    await updateS3BucketPolicy(s3Client, s3BucketName, s3Policy, revisedStatements);

    // Write audit event
    await this.audit(requestContext, { action: 'add-egress-store-to-bucket-policy', body: s3Policy });
  }

  async removeEgressStoreBucketPolicy(requestContext, egressStore, memberAccountId) {
    const { s3BucketName, s3Policy } = await this.getS3BucketAndPolicy();

    const statementParamFunctions = [getStatementParamsFn, putStatementParamsFn, listStatementParamsFn];
    const revisedStatement = await getRevisedS3Statements(
      s3Policy,
      egressStore,
      s3BucketName,
      statementParamFunctions,
      oldStatement => removeAccountFromStatement(oldStatement, memberAccountId),
    );

    const s3Client = await this.getS3();
    await updateS3BucketPolicy(s3Client, s3BucketName, s3Policy, revisedStatement);

    await this.audit(requestContext, { action: 'remove-egress-store-from-bucket-policy', body: s3Policy });
  }

  async getMemberAccountId(requestContext, environmentId) {
    const environmentScService = await this.service('environmentScService');
    const environmentScEntity = await environmentScService.mustFind(requestContext, { id: environmentId });
    const memberAccount = await environmentScService.getMemberAccount(requestContext, environmentScEntity);
    return memberAccount.accountId;
  }

  async lockAndUpdate(lockId, dbKey, dbObject) {
    const lockService = await this.service('lockService');
    await lockService.tryWriteLockAndRun({ id: lockId }, async () => {
      await runAndCatch(
        async () => {
          return this._updater()
            .condition('attribute_exists(id)') // yes we need this to ensure the egress store does exist already
            .key({ id: dbKey })
            .item(dbObject)
            .update();
        },
        async () => {
          throw this.boom.badRequest(`Egress Store with id "${dbKey}" got updating error`, true);
        },
      );
    });
  }

  async enableEgressStoreSubmission(egressStoreInfo) {
    const egressStoreDdbLockId = `egress-store-ddb-access-${egressStoreInfo.id}`;
    egressStoreInfo.isAbleToSubmitEgressRequest = true;
    await this.lockAndUpdate(egressStoreDdbLockId, egressStoreInfo.id, egressStoreInfo);
  }
}

module.exports = DataEgressService;
