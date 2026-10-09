import { projectPortfolioBook } from "./analysis/portfolio-ledger.js";

let book = null;
let projection = null;

// The ledger becomes the source of holdings only after a committed storage write/read.
// The previous localStorage snapshot remains available for recovery.
export function setActivePortfolioBook(value) {
  projection = value ? projectPortfolioBook(value) : null;
  book = value;
}

export function getActivePortfolioBook() { return book; }
export function getPortfolioProjection() { return projection; }
