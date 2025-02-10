/*
 * Copyright 2024 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  AnyApiFactory,
  createApiFactory,
} from '@backstage/core-plugin-api';
import { grpcDocsApiWidget } from './widgets';
import { apiDocsConfigRef, defaultDefinitionWidgets } from '@backstage/plugin-api-docs';
import { ApiEntity } from '@backstage/catalog-model';

export const protocGenDocApiDocApi: AnyApiFactory = createApiFactory({
  api: apiDocsConfigRef,
  deps: {},
  factory: () => {
    // load the default widgets
    const definitionWidgets = defaultDefinitionWidgets();
    // add the grpc-docs api widget to the definition widgets
    definitionWidgets.push(grpcDocsApiWidget);
    return {
      getApiDefinitionWidget: (apiEntity: ApiEntity) => {
        // find the widget for the type of api entity
        return definitionWidgets.find(d => d.type === apiEntity.spec.type);
      },
    };
  },
});
