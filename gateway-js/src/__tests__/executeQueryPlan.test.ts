import { getIntrospectionQuery, GraphQLSchema } from 'graphql';
import { addResolversToSchema, GraphQLResolverMap } from 'apollo-graphql';
import gql from 'graphql-tag';
import { GraphQLRequestContext } from 'apollo-server-types';
import { AuthenticationError, ForbiddenError } from 'apollo-server-core';
import { buildOperationContext } from '../operationContext';
import { executeQueryPlan } from '../executeQueryPlan';
import { LocalGraphQLDataSource } from '../datasources/LocalGraphQLDataSource';
import { astSerializer, queryPlanSerializer } from 'apollo-federation-integration-testsuite';
import { getFederatedTestingSchema } from './execution-utils';
import { QueryPlanner } from '@apollo/query-planner';

expect.addSnapshotSerializer(astSerializer);
expect.addSnapshotSerializer(queryPlanSerializer);

describe('executeQueryPlan', () => {
  let serviceMap: {
    [serviceName: string]: LocalGraphQLDataSource;
  };

  function overrideResolversInService(
    serviceName: string,
    resolvers: GraphQLResolverMap,
  ) {
    addResolversToSchema(serviceMap[serviceName].schema, resolvers);
  }

  function spyOnEntitiesResolverInService(serviceName: string) {
    const entitiesField = serviceMap[serviceName].schema
      .getQueryType()!
      .getFields()['_entities'];
    return jest.spyOn(entitiesField, 'resolve');
  }

  let schema: GraphQLSchema;
  let queryPlanner: QueryPlanner;

  beforeEach(() => {
    expect(
      () =>
        ({
          serviceMap,
          schema,
          queryPlanner,
        } = getFederatedTestingSchema()),
    ).not.toThrow();
  });

  function buildRequestContext(): GraphQLRequestContext {
     // @ts-ignore
    return {
      cache: undefined as any,
      context: {},
      request: {
        variables: {},
      },
    };
  }

  describe(`errors`, () => {
    it(`should not include an empty "errors" array when no errors were encountered`, async () => {
      const operationString = `#graphql
        query {
          me {
            name {
              first
              last
            }
          }
        }
      `;

      const operationDocument = gql(operationString);

      const operationContext = buildOperationContext({
        schema,
        operationDocument,
      });

      const queryPlan = queryPlanner.buildQueryPlan(operationContext);

      const response = await executeQueryPlan(
        queryPlan,
        serviceMap,
        buildRequestContext(),
        operationContext,
      );

      expect(response).not.toHaveProperty('errors');
    });

    it(`should include an error when a root-level field errors out`, async () => {
      overrideResolversInService('accounts', {
        RootQuery: {
          me() {
            throw new AuthenticationError('Something went wrong');
          },
        },
      });

      const operationString = `#graphql
        query {
          me {
            name {
              first
              last
            }
          }
        }
      `;

      const operationDocument = gql(operationString);

      const operationContext = buildOperationContext({
        schema,
        operationDocument,
      });

      const queryPlan = queryPlanner.buildQueryPlan(operationContext);

      const response = await executeQueryPlan(
        queryPlan,
        serviceMap,
        buildRequestContext(),
        operationContext,
      );

      expect(response).toHaveProperty('data.me', null);
      expect(response).toHaveProperty(
        'errors.0.message',
        'Something went wrong',
      );
      expect(response).toHaveProperty(
        'errors.0.extensions.code',
        'UNAUTHENTICATED',
      );
      expect(response).toHaveProperty(
        'errors.0.extensions.serviceName',
        'accounts',
      );
      expect(response).toHaveProperty(
        'errors.0.extensions.query',
        '{me{name{first last}}}',
      );
      expect(response).toHaveProperty('errors.0.extensions.variables', {});
    });

    it(`should include correct error path in case one of the services raised an error`, async () => {
      overrideResolversInService('accounts', {
        User: {
          __resolveObject() {
            throw new ForbiddenError('Something went wrong');
          },
        },
      });

      const operationString = `#graphql
        query {
          topReviews(first: 2) {
            id
            author {
              name {
                first
              }
            }
          }
        }
      `;

      const operationDocument = gql(operationString);

      const operationContext = buildOperationContext({
        schema,
        operationDocument,
      });

      const queryPlan = queryPlanner.buildQueryPlan(operationContext);

      const response = await executeQueryPlan(
        queryPlan,
        serviceMap,
        buildRequestContext(),
        operationContext,
      );

      expect(response).toHaveProperty(
        'errors.0.path',
        ['topReviews', 0, 'author', 'name'],
      );

      expect(response).toHaveProperty(
        'errors.1.path',
        ['topReviews', 1, 'author', 'name'],
      );
    });

    it(`should not send request to downstream services when all entities are undefined`, async () => {
      const accountsEntitiesResolverSpy = spyOnEntitiesResolverInService(
        'accounts',
      );

      const operationString = `#graphql
        query {
          # The first 3 products are all Furniture
          topProducts(first: 3) {
            reviews {
              body
            }
            ... on Book {
              reviews {
                author {
                  name {
                    first
                    last
                  }
                }
              }
            }
          }
        }
      `;

      const operationDocument = gql(operationString);

      const operationContext = buildOperationContext({
        schema,
        operationDocument,
      });

      const queryPlan = queryPlanner.buildQueryPlan(operationContext);

      const response = await executeQueryPlan(
        queryPlan,
        serviceMap,
        buildRequestContext(),
        operationContext,
      );

      expect(accountsEntitiesResolverSpy).not.toHaveBeenCalled();

      expect(response).toMatchInlineSnapshot(`
        Object {
          "data": Object {
            "topProducts": Array [
              Object {
                "reviews": Array [
                  Object {
                    "body": "Love it!",
                  },
                  Object {
                    "body": "Prefer something else.",
                  },
                ],
              },
              Object {
                "reviews": Array [
                  Object {
                    "body": "Too expensive.",
                  },
                ],
              },
              Object {
                "reviews": Array [
                  Object {
                    "body": "Could be better.",
                  },
                ],
              },
            ],
          },
        }
      `);
    });

    it(`should send a request to downstream services for the remaining entities when some entities are undefined`, async () => {
      const accountsEntitiesResolverSpy = spyOnEntitiesResolverInService(
        'accounts',
      );

      const operationString = `#graphql
        query {
          # The first 3 products are all Furniture, but the next 2 are Books
          topProducts(first: 5) {
            reviews {
              body
            }
            ... on Book {
              reviews {
                author {
                  name {
                    first
                    last
                  }
                }
              }
            }
          }
        }
      `;

      const operationDocument = gql(operationString);

      const operationContext = buildOperationContext({
        schema,
        operationDocument,
      });

      const queryPlan = queryPlanner.buildQueryPlan(operationContext);

      const response = await executeQueryPlan(
        queryPlan,
        serviceMap,
        buildRequestContext(),
        operationContext,
      );

      expect(accountsEntitiesResolverSpy).toHaveBeenCalledTimes(1);
      expect(accountsEntitiesResolverSpy.mock.calls[0][1]).toEqual({
        representations: [
          { __typename: 'User', id: '2' },
          { __typename: 'User', id: '2' },
        ],
      });

      expect(response).toMatchInlineSnapshot(`
        Object {
          "data": Object {
            "topProducts": Array [
              Object {
                "reviews": Array [
                  Object {
                    "body": "Love it!",
                  },
                  Object {
                    "body": "Prefer something else.",
                  },
                ],
              },
              Object {
                "reviews": Array [
                  Object {
                    "body": "Too expensive.",
                  },
                ],
              },
              Object {
                "reviews": Array [
                  Object {
                    "body": "Could be better.",
                  },
                ],
              },
              Object {
                "reviews": Array [
                  Object {
                    "author": Object {
                      "name": Object {
                        "first": "Alan",
                        "last": "Turing",
                      },
                    },
                    "body": "Wish I had read this before.",
                  },
                ],
              },
              Object {
                "reviews": Array [
                  Object {
                    "author": Object {
                      "name": Object {
                        "first": "Alan",
                        "last": "Turing",
                      },
                    },
                    "body": "A bit outdated.",
                  },
                ],
              },
            ],
          },
        }
      `);
    });

    it(`should not send request to downstream service when entities don't match type conditions`, async () => {
      const reviewsEntitiesResolverSpy = spyOnEntitiesResolverInService(
        'reviews',
      );

      const operationString = `#graphql
        query {
          # The first 3 products are all Furniture
          topProducts(first: 3) {
            ... on Book {
              reviews {
                body
              }
            }
          }
        }
      `;

      const operationDocument = gql(operationString);

      const operationContext = buildOperationContext({
        schema,
        operationDocument,
      });

      const queryPlan = queryPlanner.buildQueryPlan(operationContext);

      const response = await executeQueryPlan(
        queryPlan,
        serviceMap,
        buildRequestContext(),
        operationContext,
      );

      expect(reviewsEntitiesResolverSpy).not.toHaveBeenCalled();

      expect(response).toMatchInlineSnapshot(`
        Object {
          "data": Object {
            "topProducts": Array [
              Object {},
              Object {},
              Object {},
            ],
          },
        }
      `);
    });

    it(`should send a request to downstream services for the remaining entities when some entities don't match type conditions`, async () => {
      const reviewsEntitiesResolverSpy = spyOnEntitiesResolverInService(
        'reviews',
      );

      const operationString = `#graphql
        query {
          # The first 3 products are all Furniture, but the next 2 are Books
          topProducts(first: 5) {
            ... on Book {
              reviews {
                body
              }
            }
          }
        }
      `;

      const operationDocument = gql(operationString);

      const operationContext = buildOperationContext({
        schema,
        operationDocument,
      });

      const queryPlan = queryPlanner.buildQueryPlan(operationContext);

      const response = await executeQueryPlan(
        queryPlan,
        serviceMap,
        buildRequestContext(),
        operationContext,
      );

      expect(reviewsEntitiesResolverSpy).toHaveBeenCalledTimes(1);
      expect(reviewsEntitiesResolverSpy.mock.calls[0][1]).toEqual({
        representations: [
          { __typename: 'Book', isbn: '0262510871' },
          { __typename: 'Book', isbn: '0136291554' },
        ],
      });

      expect(response).toMatchInlineSnapshot(`
        Object {
          "data": Object {
            "topProducts": Array [
              Object {},
              Object {},
              Object {},
              Object {
                "reviews": Array [
                  Object {
                    "body": "Wish I had read this before.",
                  },
                ],
              },
              Object {
                "reviews": Array [
                  Object {
                    "body": "A bit outdated.",
                  },
                ],
              },
            ],
          },
        }
      `);
    });

    it(`should still include other root-level results if one root-level field errors out`, async () => {
      overrideResolversInService('accounts', {
        RootQuery: {
          me() {
            throw new Error('Something went wrong');
          },
        },
      });

      const operationString = `#graphql
        query {
          me {
            name {
              first
              last
            }
          }
          topReviews {
            body
          }
        }
      `;

      const operationDocument = gql(operationString);

      const operationContext = buildOperationContext({
        schema,
        operationDocument,
      });

      const queryPlan = queryPlanner.buildQueryPlan(operationContext);

      const response = await executeQueryPlan(
        queryPlan,
        serviceMap,
        buildRequestContext(),
        operationContext,
      );

      expect(response).toHaveProperty('data.me', null);
      expect(response).toHaveProperty('data.topReviews', expect.any(Array));
    });

    it(`should still include data from other services if one services is unavailable`, async () => {
      delete serviceMap.accounts;

      const operationString = `#graphql
        query {
          me {
            name {
              first
              last
            }
          }
          topReviews {
            body
          }
        }
      `;

      const operationDocument = gql(operationString);

      const operationContext = buildOperationContext({
        schema,
        operationDocument,
      });

      const queryPlan = queryPlanner.buildQueryPlan(operationContext);

      const response = await executeQueryPlan(
        queryPlan,
        serviceMap,
        buildRequestContext(),
        operationContext,
      );

      expect(response).toHaveProperty('data.me', null);
      expect(response).toHaveProperty('data.topReviews', expect.any(Array));
    });
  });

  it(`should only return fields that have been requested directly`, async () => {
    const operationString = `#graphql
      query {
        topReviews {
          body
          author {
            name {
              first
              last
            }
          }
        }
      }
    `;

    const operationDocument = gql(operationString);

    const operationContext = buildOperationContext({
      schema,
      operationDocument,
    });

    const queryPlan = queryPlanner.buildQueryPlan(operationContext);

    const response = await executeQueryPlan(
      queryPlan,
      serviceMap,
      buildRequestContext(),
      operationContext,
    );

    expect(response.data).toMatchInlineSnapshot(`
      Object {
        "topReviews": Array [
          Object {
            "author": Object {
              "name": Object {
                "first": "Ada",
                "last": "Lovelace",
              },
            },
            "body": "Love it!",
          },
          Object {
            "author": Object {
              "name": Object {
                "first": "Ada",
                "last": "Lovelace",
              },
            },
            "body": "Too expensive.",
          },
          Object {
            "author": Object {
              "name": Object {
                "first": "Alan",
                "last": "Turing",
              },
            },
            "body": "Could be better.",
          },
          Object {
            "author": Object {
              "name": Object {
                "first": "Alan",
                "last": "Turing",
              },
            },
            "body": "Prefer something else.",
          },
          Object {
            "author": Object {
              "name": Object {
                "first": "Alan",
                "last": "Turing",
              },
            },
            "body": "Wish I had read this before.",
          },
        ],
      }
    `);
  });

  it('should not duplicate variable definitions', async () => {
    const operationString = `#graphql
      query Test($first: Int!) {
        first: topReviews(first: $first) {
          body
          author {
            name {
              first
              last
            }
          }
        }
        second: topReviews(first: $first) {
          body
          author {
            name {
              first
              last
            }
          }
        }
      }
    `;

    const operationDocument = gql(operationString);

    const operationContext = buildOperationContext({
      schema,
      operationDocument,
    });

    const queryPlan = queryPlanner.buildQueryPlan(operationContext);

    const requestContext = buildRequestContext();
    requestContext.request.variables = { first: 3 };

    const response = await executeQueryPlan(
      queryPlan,
      serviceMap,
      requestContext,
      operationContext,
    );

    expect(response.data).toMatchInlineSnapshot(`
      Object {
        "first": Array [
          Object {
            "author": Object {
              "name": Object {
                "first": "Ada",
                "last": "Lovelace",
              },
            },
            "body": "Love it!",
          },
          Object {
            "author": Object {
              "name": Object {
                "first": "Ada",
                "last": "Lovelace",
              },
            },
            "body": "Too expensive.",
          },
          Object {
            "author": Object {
              "name": Object {
                "first": "Alan",
                "last": "Turing",
              },
            },
            "body": "Could be better.",
          },
        ],
        "second": Array [
          Object {
            "author": Object {
              "name": Object {
                "first": "Ada",
                "last": "Lovelace",
              },
            },
            "body": "Love it!",
          },
          Object {
            "author": Object {
              "name": Object {
                "first": "Ada",
                "last": "Lovelace",
              },
            },
            "body": "Too expensive.",
          },
          Object {
            "author": Object {
              "name": Object {
                "first": "Alan",
                "last": "Turing",
              },
            },
            "body": "Could be better.",
          },
        ],
      }
    `);
  });

  it('should include variables in non-root requests', async () => {
    const operationString = `#graphql
      query Test($locale: String) {
        topReviews {
          body
          author {
            name {
              first
              last
            }
            birthDate(locale: $locale)
          }
        }
      }
    `;

    const operationDocument = gql(operationString);

    const operationContext = buildOperationContext({
      schema,
      operationDocument,
    });

    const queryPlan = queryPlanner.buildQueryPlan(operationContext);

    const requestContext = buildRequestContext();
    requestContext.request.variables = { locale: 'en-US' };

    const response = await executeQueryPlan(
      queryPlan,
      serviceMap,
      requestContext,
      operationContext,
    );

    expect(response.data).toMatchInlineSnapshot(`
      Object {
        "topReviews": Array [
          Object {
            "author": Object {
              "birthDate": "12/10/1815",
              "name": Object {
                "first": "Ada",
                "last": "Lovelace",
              },
            },
            "body": "Love it!",
          },
          Object {
            "author": Object {
              "birthDate": "12/10/1815",
              "name": Object {
                "first": "Ada",
                "last": "Lovelace",
              },
            },
            "body": "Too expensive.",
          },
          Object {
            "author": Object {
              "birthDate": "6/23/1912",
              "name": Object {
                "first": "Alan",
                "last": "Turing",
              },
            },
            "body": "Could be better.",
          },
          Object {
            "author": Object {
              "birthDate": "6/23/1912",
              "name": Object {
                "first": "Alan",
                "last": "Turing",
              },
            },
            "body": "Prefer something else.",
          },
          Object {
            "author": Object {
              "birthDate": "6/23/1912",
              "name": Object {
                "first": "Alan",
                "last": "Turing",
              },
            },
            "body": "Wish I had read this before.",
          },
        ],
      }
    `);
  });

  it('can execute an introspection query', async () => {
    const operationContext = buildOperationContext({
      schema,
      operationDocument: gql`
        ${getIntrospectionQuery()}
      `,
    });
    const queryPlan = queryPlanner.buildQueryPlan(operationContext);

    const response = await executeQueryPlan(
      queryPlan,
      serviceMap,
      buildRequestContext(),
      operationContext,
    );

    expect(response.data).toHaveProperty('__schema');
    expect(response.errors).toBeUndefined();
  });

  it(`can execute queries on interface types`, async () => {
    const operationString = `#graphql
      query {
        vehicle(id: "1") {
          description
          price
          retailPrice
        }
      }
    `;

    const operationDocument = gql(operationString);

    const operationContext = buildOperationContext({
      schema,
      operationDocument,
    });

    const queryPlan = queryPlanner.buildQueryPlan(operationContext);

    const response = await executeQueryPlan(
      queryPlan,
      serviceMap,
      buildRequestContext(),
      operationContext,
    );

    expect(response.data).toMatchInlineSnapshot(`
      Object {
        "vehicle": Object {
          "description": "Humble Toyota",
          "price": "9990",
          "retailPrice": "9990",
        },
      }
    `);
  });

  it(`can execute queries whose fields are interface types`, async () => {
    const operationString = `#graphql
      query {
        user(id: "1") {
          name {
            first
            last
          }
          vehicle {
            description
            price
            retailPrice
          }
        }
      }
    `;

    const operationDocument = gql(operationString);

    const operationContext = buildOperationContext({
      schema,
      operationDocument,
    });

    const queryPlan = queryPlanner.buildQueryPlan(operationContext);

    const response = await executeQueryPlan(
      queryPlan,
      serviceMap,
      buildRequestContext(),
      operationContext,
    );

    expect(response.data).toMatchInlineSnapshot(`
      Object {
        "user": Object {
          "name": Object {
            "first": "Ada",
            "last": "Lovelace",
          },
          "vehicle": Object {
            "description": "Humble Toyota",
            "price": "9990",
            "retailPrice": "9990",
          },
        },
      }
    `);
  });

  it(`can execute queries whose fields are union types`, async () => {
    const operationString = `#graphql
      query {
        user(id: "1") {
          name {
            first
            last
          }
          thing {
            ... on Vehicle {
              description
              price
              retailPrice
            }
            ... on Ikea {
              asile
            }
          }
        }
      }
    `;

    const operationDocument = gql(operationString);

    const operationContext = buildOperationContext({
      schema,
      operationDocument,
    });

    const queryPlan = queryPlanner.buildQueryPlan(operationContext);

    const response = await executeQueryPlan(
      queryPlan,
      serviceMap,
      buildRequestContext(),
      operationContext,
    );

    expect(response.data).toMatchInlineSnapshot(`
      Object {
        "user": Object {
          "name": Object {
            "first": "Ada",
            "last": "Lovelace",
          },
          "thing": Object {
            "description": "Humble Toyota",
            "price": "9990",
            "retailPrice": "9990",
          },
        },
      }
    `);
  });

  it('can execute queries with falsey @requires (except undefined)', async () => {
    const operationString = `#graphql
      query {
        books {
          name # Requires title, year (on Book type)
        }
      }
    `;

    const operationDocument = gql(operationString);

    const operationContext = buildOperationContext({
      schema,
      operationDocument,
    });

    const queryPlan = queryPlanner.buildQueryPlan(operationContext);

    const response = await executeQueryPlan(
      queryPlan,
      serviceMap,
      buildRequestContext(),
      operationContext,
    );

    expect(response.data).toMatchInlineSnapshot(`
      Object {
        "books": Array [
          Object {
            "name": "Structure and Interpretation of Computer Programs (1996)",
          },
          Object {
            "name": "Object Oriented Software Construction (1997)",
          },
          Object {
            "name": "Design Patterns (1995)",
          },
          Object {
            "name": "The Year Was Null (null)",
          },
          Object {
            "name": " (404)",
          },
          Object {
            "name": "No Books Like This Book! (2019)",
          },
        ],
      }
    `);
  });

  it('can execute queries with list @requires', async () => {
    const operationString = `#graphql
      query {
        book(isbn: "0201633612") {
          # Requires similarBooks { isbn }
          relatedReviews {
            id
            body
          }
        }
      }
    `;

    const operationDocument = gql(operationString);

    const operationContext = buildOperationContext({
      schema,
      operationDocument,
    });

    const queryPlan = queryPlanner.buildQueryPlan(operationContext);

    const response = await executeQueryPlan(
      queryPlan,
      serviceMap,
      buildRequestContext(),
      operationContext,
    );

    expect(response.errors).toMatchInlineSnapshot(`undefined`);

    expect(response.data).toMatchInlineSnapshot(`
      Object {
        "book": Object {
          "relatedReviews": Array [
            Object {
              "body": "A classic.",
              "id": "6",
            },
            Object {
              "body": "A bit outdated.",
              "id": "5",
            },
          ],
        },
      }
    `);
  });

  it('can execute queries with selections on null @requires fields', async () => {
    const operationString = `#graphql
      query {
        book(isbn: "0987654321") {
          # Requires similarBooks { isbn }
          relatedReviews {
            id
            body
          }
        }
      }
    `;

    const operationDocument = gql(operationString);

    const operationContext = buildOperationContext({
      schema,
      operationDocument,
    });

    const queryPlan = queryPlanner.buildQueryPlan(operationContext);

    const response = await executeQueryPlan(
      queryPlan,
      serviceMap,
      buildRequestContext(),
      operationContext,
    );

    expect(response.errors).toBeUndefined();

    expect(response.data).toMatchInlineSnapshot(`
      Object {
        "book": Object {
          "relatedReviews": Array [],
        },
      }
    `);
  });

  it(`can execute queries with @include on inline fragment with extension field`, async () => {
    const operationString = `#graphql
      query {
        topProducts(first: 5) {
          ... on Book @include(if: true) {
            price
            inStock
          }
          ... on Furniture {
            price
            inStock
          }
        }
      }
    `;

    const operationDocument = gql(operationString);

    const operationContext = buildOperationContext({
      schema,
      operationDocument,
    });

    const queryPlan = queryPlanner.buildQueryPlan(operationContext);

    const response = await executeQueryPlan(
      queryPlan,
      serviceMap,
      buildRequestContext(),
      operationContext,
    );

    expect(response.data).toMatchInlineSnapshot(`
      Object {
        "topProducts": Array [
          Object {
            "inStock": true,
            "price": "899",
          },
          Object {
            "inStock": false,
            "price": "1299",
          },
          Object {
            "inStock": true,
            "price": "54",
          },
          Object {
            "inStock": true,
            "price": "39",
          },
          Object {
            "inStock": false,
            "price": "29",
          },
        ],
      }
    `);
  });
});
