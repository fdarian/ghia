import { describe, expect, it } from "vitest"
import {
  DataTransfer,
  DataTransferItem,
  DataTransferItemList,
  dataTransferControl,
  type DataTransferMode,
} from "../dom/data-transfer.js"
import "../dom-globals.js"

const FILE = { name: "a.txt", type: "text/plain", size: 1 }

function withMode(mode: DataTransferMode, fill: (dataTransfer: DataTransfer) => void = () => {}): DataTransfer {
  const dataTransfer = new DataTransfer()
  fill(dataTransfer)
  dataTransferControl(dataTransfer).mode = mode
  return dataTransfer
}

describe("DataTransfer as a global", () => {
  it("is installed with its item classes, under the names a library checks", () => {
    expect(Reflect.get(globalThis, "DataTransfer")).toBe(DataTransfer)
    expect(Reflect.get(globalThis, "DataTransferItemList")).toBe(DataTransferItemList)
    expect(Reflect.get(globalThis, "DataTransferItem")).toBe(DataTransferItem)
    expect(new DataTransfer().constructor.name).toBe("DataTransfer")
  })

  it("is constructible empty and writable, and its items cannot be constructed", () => {
    const dataTransfer = new DataTransfer()
    expect([dataTransfer.dropEffect, dataTransfer.effectAllowed]).toEqual(["none", "none"])
    expect(dataTransfer.types).toEqual([])
    expect(dataTransfer.files.length).toBe(0)
    expect(dataTransfer.items.length).toBe(0)
    dataTransfer.effectAllowed = "copyMove"
    dataTransfer.dropEffect = "move"
    expect([dataTransfer.dropEffect, dataTransfer.effectAllowed]).toEqual(["move", "copyMove"])
    dataTransfer.dropEffect = "bogus" as never
    expect(dataTransfer.dropEffect).toBe("move")
    expect(() => new (DataTransferItem as never as new () => unknown)()).toThrow(TypeError)
    expect(() => new (DataTransferItemList as never as new () => unknown)()).toThrow(TypeError)
    dataTransfer.setDragImage({}, 0, 0)
  })
})

describe("getData, setData and clearData", () => {
  it("lowercase the format and map text and url to their MIME types", () => {
    const dataTransfer = new DataTransfer()
    dataTransfer.setData("TEXT", "plain")
    dataTransfer.setData("Text/HTML", "<b>x</b>")
    dataTransfer.setData("URL", "https://a.test/")
    expect(dataTransfer.types).toEqual(["text/plain", "text/html", "text/uri-list"])
    expect(dataTransfer.getData("text/plain")).toBe("plain")
    expect(dataTransfer.getData("Text")).toBe("plain")
    expect(dataTransfer.getData("TEXT/HTML")).toBe("<b>x</b>")
    expect(dataTransfer.getData("text/uri-list")).toBe("https://a.test/")
    expect(dataTransfer.getData("missing")).toBe("")
  })

  it("gives the first URL of a list for url, and the whole list for text/uri-list", () => {
    const dataTransfer = new DataTransfer()
    dataTransfer.setData("text/uri-list", "# a comment\r\n\r\nhttps://a.test/\r\nhttps://b.test/")
    expect(dataTransfer.getData("url")).toBe("https://a.test/")
    expect(dataTransfer.getData("URL")).toBe("https://a.test/")
    expect(dataTransfer.getData("text/uri-list")).toBe("# a comment\r\n\r\nhttps://a.test/\r\nhttps://b.test/")
    dataTransfer.setData("text/uri-list", "# only a comment")
    expect(dataTransfer.getData("url")).toBe("")
  })

  it("replaces the data of a type and moves it to the end", () => {
    const dataTransfer = new DataTransfer()
    dataTransfer.setData("a/b", "1")
    dataTransfer.setData("c/d", "2")
    dataTransfer.setData("a/b", "3")
    expect(dataTransfer.types).toEqual(["c/d", "a/b"])
    expect(dataTransfer.getData("a/b")).toBe("3")
    expect(dataTransfer.items.length).toBe(2)
  })

  it("clear one type or every string, and keep the files", () => {
    const dataTransfer = new DataTransfer()
    dataTransfer.setData("a/b", "1")
    dataTransfer.setData("c/d", "2")
    dataTransfer.items.add(FILE)
    dataTransfer.clearData("A/B")
    expect(dataTransfer.types).toEqual(["c/d", "Files"])
    dataTransfer.clearData("text")
    expect(dataTransfer.types).toEqual(["c/d", "Files"])
    dataTransfer.clearData()
    expect(dataTransfer.types).toEqual(["Files"])
    expect(dataTransfer.files.length).toBe(1)
  })
})

describe("types and files", () => {
  it("are frozen, and the same array until the data changes", () => {
    const dataTransfer = new DataTransfer()
    dataTransfer.setData("a/b", "1")
    const types = dataTransfer.types
    expect(Object.isFrozen(types)).toBe(true)
    expect(dataTransfer.types).toBe(types)
    expect(() => (types as string[]).push("x")).toThrow()
    dataTransfer.setData("c/d", "2")
    expect(dataTransfer.types).not.toBe(types)
    expect(types).toEqual(["a/b"])
    expect(dataTransfer.types).toEqual(["a/b", "c/d"])
  })

  it("list Files when there is a file, and files is a frozen FileList of them", () => {
    const dataTransfer = new DataTransfer()
    expect(dataTransfer.files.item(0)).toBeNull()
    dataTransfer.items.add(FILE)
    expect(dataTransfer.types).toEqual(["Files"])
    expect(dataTransfer.files.length).toBe(1)
    expect(dataTransfer.files[0]).toBe(FILE)
    expect(dataTransfer.files.item(0)).toBe(FILE)
    expect(dataTransfer.files.item(1)).toBeNull()
    expect(Object.isFrozen(dataTransfer.files)).toBe(true)
    expect(dataTransfer.files).toEqual([FILE])
    dataTransfer.items.clear()
    expect(dataTransfer.types).toEqual([])
    expect(dataTransfer.files.length).toBe(0)
  })
})

describe("items", () => {
  it("add a string or a file, and stay consistent with getData and types", () => {
    const dataTransfer = new DataTransfer()
    const text = dataTransfer.items.add("hello", "Text/Plain")
    const file = dataTransfer.items.add(FILE)
    expect(text).toBeInstanceOf(DataTransferItem)
    expect([text?.kind, text?.type]).toEqual(["string", "text/plain"])
    expect([file?.kind, file?.type]).toEqual(["file", "text/plain"])
    expect(dataTransfer.items.length).toBe(2)
    expect(dataTransfer.items[0]).toBe(text)
    expect(dataTransfer.items[1]).toBe(file)
    expect(dataTransfer.items[2]).toBeUndefined()
    expect([...dataTransfer.items]).toEqual([text, file])
    expect(dataTransfer.getData("text")).toBe("hello")
    expect(dataTransfer.types).toEqual(["text/plain", "Files"])
    dataTransfer.setData("a/b", "x")
    expect(dataTransfer.items.length).toBe(3)
    expect(dataTransfer.items[2]?.type).toBe("a/b")
    expect(file?.getAsFile()).toBe(FILE)
    expect(text?.getAsFile()).toBeNull()
  })

  it("refuse a second string of a type, and do not rename text to text/plain", () => {
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add("a", "text/plain")
    expect(() => dataTransfer.items.add("b", "TEXT/PLAIN")).toThrowError(/already exists/)
    try {
      dataTransfer.items.add("b", "text/plain")
    } catch (error) {
      expect((error as Error).name).toBe("NotSupportedError")
    }
    dataTransfer.items.add("c", "text")
    expect(dataTransfer.types).toEqual(["text/plain", "text"])
  })

  it("hand the string to getAsString in a later task, and only while it is in the list", async () => {
    const dataTransfer = new DataTransfer()
    const item = dataTransfer.items.add("hello", "text/plain")!
    const seen: string[] = []
    item.getAsString((data) => seen.push(data))
    expect(seen).toEqual([])
    await Promise.resolve()
    expect(seen).toEqual(["hello"])
    item.getAsString(null)
    dataTransfer.items.remove(0)
    item.getAsString((data) => seen.push(data))
    await Promise.resolve()
    expect(seen).toEqual(["hello"])
    expect(dataTransfer.items.length).toBe(0)
    expect(dataTransfer.items[0]).toBeUndefined()
  })

  it("remove one item, clear them all, and drop the index properties", () => {
    const dataTransfer = new DataTransfer()
    dataTransfer.setData("a/b", "1")
    dataTransfer.setData("c/d", "2")
    dataTransfer.setData("e/f", "3")
    dataTransfer.items.remove(1)
    expect(dataTransfer.types).toEqual(["a/b", "e/f"])
    expect(dataTransfer.items[1]?.type).toBe("e/f")
    expect(2 in dataTransfer.items).toBe(false)
    dataTransfer.items.remove(9)
    expect(dataTransfer.items.length).toBe(2)
    dataTransfer.items.clear()
    expect(dataTransfer.items.length).toBe(0)
    expect(0 in dataTransfer.items).toBe(false)
    expect(dataTransfer.types).toEqual([])
  })
})

describe("modes", () => {
  it("read-only: getData works, nothing can be changed", () => {
    const dataTransfer = withMode("readonly", (made) => {
      made.setData("text/plain", "kept")
      made.items.add(FILE)
    })
    dataTransfer.setData("text/plain", "changed")
    dataTransfer.setData("a/b", "new")
    dataTransfer.clearData()
    dataTransfer.effectAllowed = "all"
    expect(dataTransfer.getData("text/plain")).toBe("kept")
    expect(dataTransfer.types).toEqual(["text/plain", "Files"])
    expect(dataTransfer.effectAllowed).toBe("none")
    expect(dataTransfer.items.add("x", "a/b")).toBeNull()
    expect(dataTransfer.items.add(FILE)).toBeNull()
    expect(() => dataTransfer.items.remove(0)).toThrowError(/not writable/)
    dataTransfer.items.clear()
    expect(dataTransfer.items.length).toBe(2)
    expect(dataTransfer.items[1]?.getAsFile()).toBe(FILE)
  })

  it("protected: types are listed, the data is not", async () => {
    const dataTransfer = withMode("protected", (made) => made.setData("text/plain", "secret"))
    expect(dataTransfer.getData("text/plain")).toBe("")
    expect(dataTransfer.types).toEqual(["text/plain"])
    expect(dataTransfer.items.length).toBe(1)
    expect([dataTransfer.items[0]?.kind, dataTransfer.items[0]?.type]).toEqual(["string", "text/plain"])
    const seen: string[] = []
    dataTransfer.items[0]?.getAsString((data) => seen.push(data))
    await Promise.resolve()
    expect(seen).toEqual([])
    dataTransfer.setData("a/b", "x")
    expect(dataTransfer.types).toEqual(["text/plain"])
  })

  it("switches back to read/write for the runtime, which a handler cannot reach", () => {
    const dataTransfer = withMode("readonly", (made) => made.setData("a/b", "1"))
    expect(Object.getOwnPropertyNames(DataTransfer.prototype)).not.toContain("mode")
    dataTransferControl(dataTransfer).mode = "readwrite"
    dataTransfer.setData("c/d", "2")
    expect(dataTransfer.types).toEqual(["a/b", "c/d"])
  })

  it("lets the runtime set effectAllowed in any mode", () => {
    const dataTransfer = withMode("protected")
    dataTransferControl(dataTransfer).effectAllowed = "uninitialized"
    expect(dataTransfer.effectAllowed).toBe("uninitialized")
  })
})
