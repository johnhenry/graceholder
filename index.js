import gql from "graphql-tag";
import { faker } from "@snaplet/copycat";

const generateMockData = (query) => {
  const parsedQuery = gql(query);
  return mockQueryFields(parsedQuery.definitions[0].selectionSet.selections);
};

const mockQueryFields = (fields) => {
  const result = {};

  for (const field of fields) {
    const { name, selectionSet } = field;

    if (selectionSet) {
      result[name.value] = mockQueryFields(selectionSet.selections);
    } else {
      result[name.value] = mockScalarField(name.value);
    }
  }

  return result;
};

const mockScalarField = (fieldName) => {
  switch (fieldName.toLowerCase()) {
    case "id":
      return faker.string.uuid();
    case "name":
      return faker.person.fullName();
    case "email":
      return faker.internet.email();
    case "age":
      return faker.number.int({ min: 18, max: 99 });
    default:
      return faker.word.sample();
  }
};

export default generateMockData;
